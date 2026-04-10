#!/usr/bin/env python3
"""
SDFT Phase 1 - Distillation Dataset Generation

For each collected trajectory, calls the teacher model (Claude Opus) to
add step-by-step reasoning annotations. Outputs an enriched JSONL dataset
suitable for LoRA fine-tuning.

Usage:
  python scripts/sdft/generate-distillation-dataset.py \
    --input data/trajectories.jsonl \
    --output data/distillation-dataset.jsonl \
    --api-key "$ANTHROPIC_API_KEY" \
    --concurrency 5 \
    --model claude-opus-4-6
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

import anthropic

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

TEACHER_SYSTEM_PROMPT = """You are an expert AI agent trajectory analyst. Given an agent's task execution trajectory (the task description, message history, tools used, and outcome), your job is to annotate each significant step with the reasoning that drove it.

For each step, explain:
1. What the agent observed or decided at this point
2. Why this action was chosen over alternatives
3. What information was being leveraged from prior steps
4. Any implicit strategy or pattern being followed

Output your analysis as a JSON object with this structure:
{
  "overall_strategy": "Brief description of the agent's overall approach",
  "reasoning_trace": [
    {
      "step": 1,
      "action_summary": "What the agent did",
      "reasoning": "Why it did this, what it was thinking",
      "key_insight": "The transferable lesson from this step"
    }
  ],
  "quality_assessment": {
    "efficiency": "1-5 rating of how efficiently the task was completed",
    "correctness": "1-5 rating of solution correctness",
    "adaptability": "1-5 rating of how well the agent adapted to challenges"
  }
}

Be precise and analytical. Focus on reasoning patterns that would help a student model learn to replicate this behavior."""


def format_trajectory_for_teacher(trajectory: dict[str, Any]) -> str:
    """Format a trajectory record into a prompt for the teacher model."""
    parts = [f"## Task\n{trajectory.get('task', 'Unknown task')}"]

    messages = trajectory.get("messages", [])
    if messages:
        parts.append("## Message History")
        for i, msg in enumerate(messages):
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            # Truncate very long messages to stay within context budget
            if len(content) > 2000:
                content = content[:2000] + "\n... [truncated]"
            parts.append(f"### Message {i + 1} ({role})\n{content}")

            if "tool_calls" in msg:
                for tc in msg["tool_calls"]:
                    tool_name = tc.get("name", tc.get("function", "unknown"))
                    parts.append(f"  Tool call: {tool_name}")
                    if "result" in tc:
                        result = tc["result"]
                        if len(str(result)) > 500:
                            result = str(result)[:500] + "... [truncated]"
                        parts.append(f"  Result: {result}")

    tools = trajectory.get("tools_used", [])
    if tools:
        parts.append(f"## Tools Used\n{', '.join(tools)}")

    outcome = trajectory.get("outcome", "")
    if outcome:
        parts.append(f"## Outcome\n{outcome}")

    role = trajectory.get("agent_role", "")
    if role:
        parts.append(f"## Agent Role\n{role}")

    return "\n\n".join(parts)


async def annotate_trajectory(
    client: anthropic.AsyncAnthropic,
    trajectory: dict[str, Any],
    model: str,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any] | None:
    """Call teacher model to annotate a single trajectory with reasoning."""
    async with semaphore:
        trajectory_id = trajectory.get("id", "unknown")
        user_prompt = format_trajectory_for_teacher(trajectory)

        try:
            response = await client.messages.create(
                model=model,
                max_tokens=4096,
                system=TEACHER_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_prompt}],
            )

            content = response.content[0].text

            # Parse the JSON response from the teacher
            # Find JSON in the response (teacher may wrap it in markdown)
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start == -1 or json_end <= json_start:
                logger.warning(
                    "Trajectory %s: teacher response did not contain valid JSON",
                    trajectory_id,
                )
                return None

            annotation = json.loads(content[json_start:json_end])

            return {
                **trajectory,
                "teacher_annotation": annotation,
                "teacher_model": model,
            }

        except json.JSONDecodeError as e:
            logger.warning(
                "Trajectory %s: failed to parse teacher JSON: %s",
                trajectory_id,
                e,
            )
            return None
        except anthropic.APIError as e:
            logger.warning(
                "Trajectory %s: API error: %s",
                trajectory_id,
                e,
            )
            return None


async def process_batch(
    client: anthropic.AsyncAnthropic,
    trajectories: list[dict[str, Any]],
    model: str,
    concurrency: int,
) -> list[dict[str, Any]]:
    """Process all trajectories with bounded concurrency."""
    semaphore = asyncio.Semaphore(concurrency)

    tasks = [
        annotate_trajectory(client, traj, model, semaphore)
        for traj in trajectories
    ]

    results = await asyncio.gather(*tasks)
    return [r for r in results if r is not None]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate distillation dataset with teacher model annotations"
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("data/trajectories.jsonl"),
        help="Input trajectories JSONL file",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/distillation-dataset.jsonl"),
        help="Output distillation dataset JSONL file",
    )
    parser.add_argument(
        "--api-key",
        required=True,
        help="Anthropic API key",
    )
    parser.add_argument(
        "--model",
        default="claude-opus-4-6",
        help="Teacher model to use for annotations",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=5,
        help="Max concurrent API calls",
    )

    args = parser.parse_args()

    if not args.input.exists():
        logger.error("Input file not found: %s", args.input)
        sys.exit(1)

    # Load trajectories
    logger.info("Loading trajectories from %s...", args.input)
    trajectories = []
    with open(args.input) as f:
        for line in f:
            line = line.strip()
            if line:
                trajectories.append(json.loads(line))

    logger.info("Loaded %d trajectories", len(trajectories))

    if not trajectories:
        logger.error("No trajectories to process")
        sys.exit(1)

    # Initialize Anthropic client
    client = anthropic.AsyncAnthropic(api_key=args.api_key)

    # Process all trajectories
    logger.info(
        "Annotating with teacher model %s (concurrency=%d)...",
        args.model,
        args.concurrency,
    )
    annotated = asyncio.run(
        process_batch(client, trajectories, args.model, args.concurrency)
    )

    # Write output
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        for record in annotated:
            f.write(json.dumps(record) + "\n")

    success_rate = len(annotated) / len(trajectories) * 100
    logger.info(
        "Done. %d/%d trajectories annotated (%.1f%% success rate). Output: %s",
        len(annotated),
        len(trajectories),
        success_rate,
        args.output,
    )

    if success_rate < 90:
        logger.warning(
            "Annotation success rate below 90%%. "
            "Review failed trajectories and re-run if needed."
        )


if __name__ == "__main__":
    main()
