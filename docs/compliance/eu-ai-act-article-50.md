# EU AI Act Article 50 — Transparency & Audit Compliance

Minion implements structured audit logging and compliance gating to meet EU AI Act Article 50 transparency obligations. This document covers what Minion logs, how to configure audit mode, how to generate compliance reports, and how to use the compliance gate to enforce data-flow policies.

## What Minion Logs and Why

Article 50 requires AI systems to maintain transparency about how they process user data, particularly when data is transferred to external services. Minion's audit system records every tool call made by an AI agent, capturing:

| Field              | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `id`               | Unique identifier for each audit entry (UUID)         |
| `timestamp`        | ISO 8601 timestamp of the tool call                   |
| `agentId`          | The AI agent that initiated the call                  |
| `sessionKey`       | Session identifier for correlation                    |
| `toolName`         | Name of the tool invoked                              |
| `params`           | Tool call parameters (for data-flow analysis)         |
| `paramCategories`  | Classified data categories present in params          |
| `resultSummary`    | Truncated result (max 200 chars, no raw PII stored)   |
| `resultCategories` | Data categories detected in the result                |
| `durationMs`       | Execution time in milliseconds                        |
| `error`            | Error message if the tool call failed                 |
| `consentScope`     | User consent level: `implicit`, `explicit`, or `none` |
| `violations`       | Policy violations detected during the call            |

### Data Categories

The classifier identifies the following categories in tool call parameters and results:

| Category          | Examples                        | Sensitivity |
| ----------------- | ------------------------------- | ----------- |
| `credentials`     | API keys, tokens, passwords     | High        |
| `user_identity`   | Email, phone, user ID, name     | High        |
| `user_location`   | GPS, IP address, city, country  | High        |
| `message_history` | Chat logs, conversation threads | Medium      |
| `file_content`    | Uploaded files, documents       | Medium      |
| `user_content`    | Message text, queries, prompts  | Medium      |
| `metadata`        | Timestamps, session IDs         | Low         |
| `tool_output`     | External tool responses         | Low         |

### Violation Types

| Violation                           | Trigger                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `unknown_tool`                      | Tool has no privacy declaration (conservative flag)   |
| `undeclared_data_category`          | Params contain categories not declared in tool policy |
| `external_transfer_without_consent` | Sensitive data sent externally without user consent   |
| `policy_mismatch`                   | Tool behaviour conflicts with declared policy         |

## How to Enable Audit Mode

Add the `audit` section to your `minion.config.yml`:

```yaml
# minion.config.yml
audit:
  enabled: true
  dir: ~/.minion/audit # Optional, default: ~/.minion/audit/
  complianceGate: false # Optional, default: false
```

### Configuration Options

| Option           | Type    | Default            | Description                                    |
| ---------------- | ------- | ------------------ | ---------------------------------------------- |
| `enabled`        | boolean | `false`            | Enable audit logging                           |
| `dir`            | string  | `~/.minion/audit/` | Directory for audit log files                  |
| `complianceGate` | boolean | `false`            | Block tool calls that violate consent policies |

When `enabled` is `true`, Minion registers `before_tool_call` and `after_tool_call` hooks that intercept every tool invocation, classify data categories, detect violations, and write structured audit entries.

## How to Generate a Compliance Report

Compliance reports aggregate audit log data into a format suitable for enterprise security reviews.

### Programmatic Usage

```typescript
import { createAuditStore } from "./audit/audit-store.js";
import { generateComplianceReport, formatComplianceReport } from "./audit/compliance-report.js";

const store = createAuditStore({ dir: "~/.minion/audit", enabled: true });

// Read entries for a date range
const entries = await store.readRange(new Date("2026-04-01"), new Date("2026-04-30"));

// Generate structured report
const report = generateComplianceReport(entries, new Date("2026-04-01"), new Date("2026-04-30"));

// Format as markdown
const markdown = formatComplianceReport(report);
console.log(markdown);
```

### Report Contents

The compliance report includes:

- **Summary metrics**: Total tool calls, external transfers, violation count
- **Tool call breakdown**: Calls per tool name
- **Data categories processed**: All categories observed in the reporting period
- **External transfer tools**: Tools that transferred data to external services
- **Violations**: Detailed list with entry IDs, timestamps, and descriptions
- **Violation summary by type**: Aggregate counts per violation type

### Sample Report Output

```
# Compliance Report — EU AI Act Article 50

**Generated:** 2026-04-10T15:30:00Z
**Period:** 2026-04-01T00:00:00Z — 2026-04-30T23:59:59Z

## Summary

| Metric | Value |
|--------|-------|
| Total tool calls | 1,247 |
| External transfers | 89 |
| Calls with violations | 3 |
| Data categories observed | 6 |

## Tool Call Breakdown

| Tool | Calls |
|------|-------|
| bash | 523 |
| read_file | 312 |
| web_search | 89 |
| memory_store | 234 |
| llm_call | 89 |
```

## How to Configure the Compliance Gate

The compliance gate actively blocks tool calls that would violate data-flow policies. Enable it for environments where preventing unauthorized external data transfers is mandatory.

```yaml
audit:
  enabled: true
  complianceGate: true
```

### How the Compliance Gate Works

When `complianceGate: true`:

1. **Before every tool call**, the audit plugin:
   - Classifies data categories in the tool parameters
   - Looks up the tool's privacy declaration
   - Runs violation detection

2. **If violations are found**, the plugin returns `{ block: true, blockReason: "..." }`:
   - `undeclared_data_category`: Tool receives data types it hasn't declared
   - `external_transfer_without_consent`: Sensitive data would be sent externally without consent

3. **The tool call is prevented** and the block reason is reported to the agent

4. **An audit entry is still recorded** with the violation details and error

### What Gets Blocked

| Scenario                                                           | Blocked?           |
| ------------------------------------------------------------------ | ------------------ |
| Local tool (bash, read_file) with any data                         | No                 |
| Known third-party tool with declared categories                    | No                 |
| Known third-party tool with undeclared sensitive data              | Yes                |
| Unknown tool with any data                                         | Yes (conservative) |
| Unknown tool with sensitive data (identity, location, credentials) | Yes                |

### What Does NOT Get Blocked

- Tools with `vendor: "local"` are never blocked (no external transfer)
- Tools where all parameter categories match the declared policy
- Any tool when `complianceGate: false` (audit-only mode)

## Data Retention Guidance

### Recommended Retention Policy

For enterprise compliance, we recommend a **90-day log retention** period:

- **Minimum**: 30 days (operational debugging)
- **Recommended**: 90 days (quarterly compliance reviews)
- **Maximum**: As required by your organization's data retention policy

### Audit Log Format

Logs are stored as **JSONL** (newline-delimited JSON) files with daily rotation:

```
~/.minion/audit/
  audit-2026-04-01.jsonl
  audit-2026-04-02.jsonl
  audit-2026-04-03.jsonl
  ...
```

Each file contains one JSON object per line. Files are:

- **Append-only**: Entries are never modified or deleted
- **Flushed immediately**: Each write is fsynced to disk (no buffering)
- **Daily rotation**: One file per calendar day
- **Self-contained**: Each line is a complete, parseable JSON object

### Retention Management

Minion does not automatically delete audit logs. Implement log rotation using your existing infrastructure:

```bash
# Example: delete logs older than 90 days
find ~/.minion/audit -name "audit-*.jsonl" -mtime +90 -delete

# Example: archive to cold storage
find ~/.minion/audit -name "audit-*.jsonl" -mtime +30 \
  -exec gzip {} \; -exec mv {}.gz /archive/minion-audit/ \;
```

For enterprise deployments, integrate with your SIEM (Security Information and Event Management) system by forwarding JSONL entries to your log aggregator.

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                   Agent Runtime                   │
│                                                  │
│  ┌──────────┐    ┌──────────────┐               │
│  │  Agent    │───▶│  Tool Call   │               │
│  │  Loop     │    │  Dispatcher  │               │
│  └──────────┘    └──────┬───────┘               │
│                         │                        │
│            ┌────────────┼────────────┐          │
│            ▼            │            ▼          │
│  ┌─────────────┐       │   ┌──────────────┐    │
│  │ before_tool  │       │   │ after_tool   │    │
│  │ _call hook   │       │   │ _call hook   │    │
│  └──────┬──────┘       │   └──────┬───────┘    │
│         │              │          │             │
│         ▼              │          ▼             │
│  ┌─────────────┐       │   ┌──────────────┐    │
│  │  Classify   │       │   │  Write Audit │    │
│  │  + Detect   │       │   │  Entry       │    │
│  │  Violations │       │   └──────┬───────┘    │
│  └──────┬──────┘       │          │             │
│         │              │          ▼             │
│    block?──yes──▶ STOP │   ┌──────────────┐    │
│         │              │   │  AuditStore  │    │
│         no             │   │  (JSONL)     │    │
│         │              │   └──────────────┘    │
│         ▼              │                        │
│    Execute Tool ◀──────┘                        │
│                                                  │
└──────────────────────────────────────────────────┘
```

## FAQ

**Q: Does enabling audit mode affect agent performance?**
A: Minimal impact. The `before_tool_call` hook runs synchronously (microseconds for classification). The `after_tool_call` hook writes audit entries fire-and-forget — the store write never blocks tool execution.

**Q: Does the audit system store raw user data?**
A: Tool parameters are logged for data-flow analysis, but result summaries are truncated to 200 characters. No raw PII is stored in result fields. Organizations should review their data handling policies regarding parameter logging.

**Q: Can I add custom tool privacy declarations?**
A: The built-in registry covers common Minion tools. Unknown tools receive conservative defaults (vendor: "unknown", externalTransfer: true). Custom declarations will be supported in a future release.

**Q: What happens if the audit store directory is not writable?**
A: The store creates the directory recursively on first write. If the directory cannot be created or is not writable, the append operation will throw an error. Agent execution continues regardless — audit failures do not block tool calls.

**Q: Is the compliance gate safe for production?**
A: Yes, but review the blocking rules carefully. In `complianceGate: true` mode, all unknown tools are blocked by default. Ensure all tools your agents use have privacy declarations, or keep the gate in audit-only mode (`complianceGate: false`) until declarations are complete.
