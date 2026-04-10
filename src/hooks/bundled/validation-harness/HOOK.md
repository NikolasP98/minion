---
name: validation-harness
description: "Run quality assertions on every agent task output and produce a scored pass/fail report"
homepage: https://docs.minion.ai/automation/hooks#validation-harness
metadata:
  {
    "minion":
      {
        "emoji": "🔍",
        "events": ["message:sent"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Minion" }],
      },
  }
---

# Validation Harness Hook

Automatically validates agent task outputs on every `message:sent` event.
Produces a scored pass/fail report and appends it to the response as a Markdown comment.

## What It Does

After every task completion:

1. **Detects task type** — code, research, writing, or data_analysis (from metadata or inference)
2. **Runs assertion evaluators** — heuristic checks per the QA spec (Section 3)
3. **Calculates score** — weighted formula per Section 4
4. **Writes artifacts** — `validation-harness-<task-id>.json` and `validation-summary-<task-id>.md`
5. **Appends comment** — formatted Markdown table with pass/fail per assertion

## Grade Thresholds

| Grade            | Condition                                    |
| ---------------- | -------------------------------------------- |
| PASS             | score ≥ 85% AND all required assertions pass |
| CONDITIONAL_PASS | score ≥ 70% AND ≤ 1 required fails           |
| FAIL             | score < 70% OR 2+ required assertions fail   |

## Task Type Detection

The harness infers task type from the output:

- Code blocks → `code`
- Statistical terms (p-value, confidence interval) → `data_analysis`
- 3+ URLs → `research`
- Everything else → `writing`

Override detection by setting `taskType` in the event context metadata.

## Artifacts

Artifacts are written to `<workspace>/memory/validation/`:

- `validation-harness-<task-id>.json` — full machine-readable result
- `validation-summary-<task-id>.md` — human-readable Markdown summary
