#!/usr/bin/env python3
"""
SDFT Phase 1 - Trajectory Collection & PII Scrubbing

Collects high-quality agent task trajectories from the production database,
applies PII scrubbing via Microsoft Presidio + spaCy NER, and outputs
a validated JSONL dataset.

Architecture review (MIN-600) compliance:
  - M4: Uses Presidio for PII scrubbing with explicit entity list
  - M4: Audit trail written to data/pii-audit-log.jsonl
  - M4: Tool call results included in entity scrubbing scope

Usage:
  python scripts/sdft/collect-trajectories.py \
    --db-url "$TURSO_DATABASE_URL" \
    --auth-token "$TURSO_AUTH_TOKEN" \
    --output data/trajectories.jsonl \
    --min-rating 4 \
    --min-trajectories 500 \
    --audit-log data/pii-audit-log.jsonl
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import libsql_experimental as libsql
from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# PII entity types to detect and scrub (addresses M4 - explicit entity list)
PII_ENTITY_TYPES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "LOCATION",
    "CREDIT_CARD",
    "IBAN_CODE",
    "IP_ADDRESS",
    "US_SSN",
    "US_BANK_NUMBER",
    "US_DRIVER_LICENSE",
    "US_PASSPORT",
    "UK_NHS",
    "SG_NRIC_FIN",
    "AU_ABN",
    "AU_ACN",
    "AU_TFN",
    "AU_MEDICARE",
    "NRP",            # nationality, religion, political group
    "MEDICAL_LICENSE",
    "URL",            # may contain PII in query strings
]

# Additional regex patterns for domain-specific PII not covered by Presidio
CUSTOM_PII_PATTERNS = [
    # API keys / tokens (common patterns)
    (r"(?:sk|pk|api|token|key|secret)[_-]?[a-zA-Z0-9]{20,}", "API_KEY"),
    # AWS access keys
    (r"AKIA[0-9A-Z]{16}", "AWS_ACCESS_KEY"),
    # GitHub tokens
    (r"gh[pousr]_[A-Za-z0-9_]{36,}", "GITHUB_TOKEN"),
    # Generic bearer tokens
    (r"Bearer\s+[A-Za-z0-9\-._~+/]+=*", "BEARER_TOKEN"),
    # Database connection strings
    (r"(?:postgres|mysql|mongodb|libsql)://[^\s]+", "DATABASE_URL"),
    # File paths that may contain usernames
    (r"/(?:home|Users)/[a-zA-Z0-9._-]+", "USER_HOME_PATH"),
]


def build_analyzer() -> AnalyzerEngine:
    """Build a Presidio analyzer engine with spaCy NER backend."""
    analyzer = AnalyzerEngine()
    return analyzer


def build_anonymizer() -> AnonymizerEngine:
    """Build a Presidio anonymizer engine."""
    return AnonymizerEngine()


def scrub_text(
    text: str,
    analyzer: AnalyzerEngine,
    anonymizer: AnonymizerEngine,
    language: str = "en",
) -> tuple[str, list[dict[str, Any]]]:
    """
    Scrub PII from text using Presidio + custom regex patterns.

    Returns:
        (scrubbed_text, list of detected entities for audit trail)
    """
    if not text or not text.strip():
        return text, []

    audit_entries: list[dict[str, Any]] = []

    # Phase 1: Custom regex scrubbing (catches tokens, keys, URLs)
    scrubbed = text
    for pattern, entity_type in CUSTOM_PII_PATTERNS:
        for match in re.finditer(pattern, scrubbed):
            audit_entries.append({
                "entity_type": entity_type,
                "start": match.start(),
                "end": match.end(),
                "score": 1.0,
                "source": "custom_regex",
            })
        scrubbed = re.sub(pattern, f"<{entity_type}>", scrubbed)

    # Phase 2: Presidio NER-based scrubbing
    results: list[RecognizerResult] = analyzer.analyze(
        text=scrubbed,
        entities=PII_ENTITY_TYPES,
        language=language,
    )

    for result in results:
        audit_entries.append({
            "entity_type": result.entity_type,
            "start": result.start,
            "end": result.end,
            "score": result.score,
            "source": "presidio",
        })

    if results:
        operators = {
            entity: OperatorConfig("replace", {"new_value": f"<{entity}>"})
            for entity in PII_ENTITY_TYPES
        }
        anonymized = anonymizer.anonymize(
            text=scrubbed,
            analyzer_results=results,
            operators=operators,
        )
        scrubbed = anonymized.text

    return scrubbed, audit_entries


def scrub_trajectory(
    trajectory: dict[str, Any],
    analyzer: AnalyzerEngine,
    anonymizer: AnonymizerEngine,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Deep-scrub PII from an entire trajectory record.
    Handles nested message arrays and tool call results (addresses M4).
    """
    all_audit: list[dict[str, Any]] = []
    scrubbed = trajectory.copy()

    # Scrub task description
    if "task" in scrubbed and isinstance(scrubbed["task"], str):
        scrubbed["task"], audit = scrub_text(scrubbed["task"], analyzer, anonymizer)
        all_audit.extend(audit)

    # Scrub messages (including tool call results - M4 compliance)
    if "messages" in scrubbed and isinstance(scrubbed["messages"], list):
        scrubbed_messages = []
        for msg in scrubbed["messages"]:
            msg_copy = msg.copy()
            if "content" in msg_copy and isinstance(msg_copy["content"], str):
                msg_copy["content"], audit = scrub_text(
                    msg_copy["content"], analyzer, anonymizer
                )
                all_audit.extend(audit)

            # Scrub tool call arguments and results
            if "tool_calls" in msg_copy and isinstance(msg_copy["tool_calls"], list):
                scrubbed_tool_calls = []
                for tc in msg_copy["tool_calls"]:
                    tc_copy = tc.copy()
                    if "arguments" in tc_copy and isinstance(tc_copy["arguments"], str):
                        tc_copy["arguments"], audit = scrub_text(
                            tc_copy["arguments"], analyzer, anonymizer
                        )
                        all_audit.extend(audit)
                    if "result" in tc_copy and isinstance(tc_copy["result"], str):
                        tc_copy["result"], audit = scrub_text(
                            tc_copy["result"], analyzer, anonymizer
                        )
                        all_audit.extend(audit)
                    scrubbed_tool_calls.append(tc_copy)
                msg_copy["tool_calls"] = scrubbed_tool_calls

            scrubbed_messages.append(msg_copy)
        scrubbed["messages"] = scrubbed_messages

    # Scrub outcome
    if "outcome" in scrubbed and isinstance(scrubbed["outcome"], str):
        scrubbed["outcome"], audit = scrub_text(
            scrubbed["outcome"], analyzer, anonymizer
        )
        all_audit.extend(audit)

    return scrubbed, all_audit


def validate_scrubbed(trajectory: dict[str, Any], analyzer: AnalyzerEngine) -> bool:
    """
    Validation pass: re-analyze scrubbed text to confirm no PII remains.
    Returns True if clean.
    """
    full_text = json.dumps(trajectory)
    results = analyzer.analyze(
        text=full_text,
        entities=PII_ENTITY_TYPES,
        language="en",
    )
    high_confidence = [r for r in results if r.score >= 0.7]
    return len(high_confidence) == 0


def fetch_trajectories(
    db_url: str,
    auth_token: str,
    min_rating: int,
    limit: int,
) -> list[dict[str, Any]]:
    """
    Fetch high-quality completed task trajectories from production DB.

    Filters:
      - Tasks rated >= min_rating satisfaction OR manually flagged as exemplary
      - Status = completed
      - Has message history
    """
    conn = libsql.connect(db_url, auth_token=auth_token)

    query = """
    SELECT
        t.id,
        t.title AS task,
        t.messages,
        t.tools_used,
        t.outcome,
        t.satisfaction_rating,
        t.is_exemplary,
        t.agent_role,
        t.completed_at
    FROM agent_tasks t
    WHERE t.status = 'completed'
      AND t.messages IS NOT NULL
      AND (t.satisfaction_rating >= ? OR t.is_exemplary = 1)
    ORDER BY t.completed_at DESC
    LIMIT ?
    """

    cursor = conn.execute(query, (min_rating, limit))
    columns = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()
    conn.close()

    trajectories = []
    for row in rows:
        record = dict(zip(columns, row))
        # Parse JSON fields
        if isinstance(record.get("messages"), str):
            record["messages"] = json.loads(record["messages"])
        if isinstance(record.get("tools_used"), str):
            record["tools_used"] = json.loads(record["tools_used"])
        trajectories.append(record)

    return trajectories


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect and PII-scrub agent trajectories for SDFT"
    )
    parser.add_argument(
        "--db-url",
        required=True,
        help="Turso/LibSQL database URL",
    )
    parser.add_argument(
        "--auth-token",
        required=True,
        help="Turso auth token",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/trajectories.jsonl"),
        help="Output JSONL file path",
    )
    parser.add_argument(
        "--audit-log",
        type=Path,
        default=Path("data/pii-audit-log.jsonl"),
        help="PII scrubbing audit log path",
    )
    parser.add_argument(
        "--min-rating",
        type=int,
        default=4,
        help="Minimum satisfaction rating (1-5)",
    )
    parser.add_argument(
        "--min-trajectories",
        type=int,
        default=500,
        help="Minimum number of trajectories to collect",
    )

    args = parser.parse_args()

    # Ensure output directories exist
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.audit_log.parent.mkdir(parents=True, exist_ok=True)

    logger.info("Initializing Presidio analyzer + anonymizer...")
    analyzer = build_analyzer()
    anonymizer = build_anonymizer()

    logger.info(
        "Fetching trajectories (min_rating=%d, target=%d)...",
        args.min_rating,
        args.min_trajectories,
    )
    trajectories = fetch_trajectories(
        db_url=args.db_url,
        auth_token=args.auth_token,
        min_rating=args.min_rating,
        limit=args.min_trajectories * 2,  # fetch extra in case some fail validation
    )

    if len(trajectories) < args.min_trajectories:
        logger.warning(
            "Only found %d trajectories (target: %d). "
            "Consider lowering --min-rating or adding more exemplary flags.",
            len(trajectories),
            args.min_trajectories,
        )

    logger.info("Scrubbing PII from %d trajectories...", len(trajectories))
    valid_count = 0
    failed_validation = 0

    with (
        open(args.output, "w") as out_f,
        open(args.audit_log, "w") as audit_f,
    ):
        for i, traj in enumerate(trajectories):
            trajectory_id = traj.get("id", str(uuid.uuid4()))

            # Scrub PII
            scrubbed, audit_entries = scrub_trajectory(traj, analyzer, anonymizer)

            # Write audit log entry (M4 - audit trail)
            audit_record = {
                "trajectory_id": trajectory_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "entities_found": len(audit_entries),
                "entity_types": list({e["entity_type"] for e in audit_entries}),
                "details": audit_entries,
            }
            audit_f.write(json.dumps(audit_record) + "\n")

            # Validation pass - re-check for remaining PII
            if not validate_scrubbed(scrubbed, analyzer):
                failed_validation += 1
                logger.warning(
                    "Trajectory %s failed PII validation after scrubbing, skipping.",
                    trajectory_id,
                )
                continue

            # Write clean trajectory
            output_record = {
                "id": trajectory_id,
                "task": scrubbed.get("task", ""),
                "messages": scrubbed.get("messages", []),
                "tools_used": scrubbed.get("tools_used", []),
                "outcome": scrubbed.get("outcome", ""),
                "agent_role": scrubbed.get("agent_role", ""),
            }
            out_f.write(json.dumps(output_record) + "\n")
            valid_count += 1

            if (i + 1) % 50 == 0:
                logger.info("Processed %d/%d trajectories...", i + 1, len(trajectories))

    logger.info(
        "Done. %d valid trajectories written to %s "
        "(%d failed PII validation, %d total processed)",
        valid_count,
        args.output,
        failed_validation,
        len(trajectories),
    )

    if valid_count < args.min_trajectories:
        logger.error(
            "Only %d valid trajectories (target: %d). "
            "Dataset is below minimum threshold.",
            valid_count,
            args.min_trajectories,
        )
        sys.exit(1)

    logger.info("Audit log: %s", args.audit_log)


if __name__ == "__main__":
    main()
