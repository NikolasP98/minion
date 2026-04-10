---
name: failure-gate
description: "Hard-block done transitions when the latest validation harness grade is FAIL"
homepage: https://docs.minion.ai/automation/hooks#failure-gate
metadata:
  {
    "minion":
      {
        "emoji": "🚫",
        "events": ["agent:task_completing"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Minion" }],
      },
  }
---

# Failure Gate Hook

Prevents agents from marking a task `done` when the validation harness grade is FAIL.
Implements QA Spec MIN-170 Section 6.3.

## Behavior

When an agent attempts a `done` transition:

1. **Reads** the latest `validation-harness-*.json` from the workspace validation directory
2. **Evaluates** the grade against failure gate rules
3. **FAIL** — blocks the transition; pushes an error message citing failed assertion IDs
4. **CONDITIONAL_PASS** — allows with a warning listing which assertions failed
5. **PASS** — allows silently
6. **No result** — allows (harness may not have run)

## Integration

The gate is triggered by `agent:task_completing` events. The event context must include:

- `taskId` — the issue/task ID
- `targetStatus` — the new status being set (gate only fires for `"done"`)
- `validationDir` — path to the validation artifacts directory

If the gate blocks the transition, it sets `context.blocked = true` and `context.blockReason` on the event.
