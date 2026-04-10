/**
 * Failure Gate — hard-blocks `done` transitions when harness grade=FAIL.
 *
 * Per QA Spec MIN-170 Section 6.3:
 * - FAIL: reject transition, cite failed assertion IDs
 * - CONDITIONAL_PASS: allow with warning about failed assertions
 * - PASS: allow silently
 *
 * The gate reads the latest harness result JSON from the validation
 * artifacts directory and returns a verdict.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Grade, HarnessResult } from "./types.js";

// ── Result types ────────────────────────────────────────────────────

export interface FailureGateAllowed {
  allowed: true;
  grade: Grade;
  /** Non-empty when grade is CONDITIONAL_PASS — lists failing assertion IDs. */
  warnings: string[];
}

export interface FailureGateBlocked {
  allowed: false;
  grade: "FAIL";
  /** IDs of the assertions that failed. */
  failedAssertionIds: string[];
  /** Human-readable reason for the block. */
  reason: string;
}

export type FailureGateResult = FailureGateAllowed | FailureGateBlocked;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Read all `validation-harness-*.json` files in `dir` and return the
 * most recently generated result (by `generated_at`).
 *
 * Returns `null` when no harness artifacts are found.
 */
export async function readLatestHarnessResult(dir: string): Promise<HarnessResult | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // Directory doesn't exist — no results yet
    return null;
  }

  const jsonFiles = entries.filter(
    (f) => f.startsWith("validation-harness-") && f.endsWith(".json"),
  );

  if (jsonFiles.length === 0) {
    return null;
  }

  let latest: HarnessResult | null = null;
  let latestTime = 0;

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw) as HarnessResult;
      if (parsed.schema_version !== "1.0" || !parsed.summary?.grade) {
        continue;
      }
      const ts = new Date(parsed.generated_at).getTime();
      if (ts > latestTime) {
        latestTime = ts;
        latest = parsed;
      }
    } catch {
      // Skip malformed files
    }
  }

  return latest;
}

/**
 * Evaluate a HarnessResult against the failure gate rules.
 *
 * - FAIL  -> blocked (with failed assertion IDs)
 * - CONDITIONAL_PASS -> allowed with warnings
 * - PASS  -> allowed, no warnings
 */
export function evaluateGate(result: HarnessResult): FailureGateResult {
  const { grade } = result.summary;
  const failedAssertions = result.assertions.filter((a) => a.status === "fail");

  if (grade === "FAIL") {
    const ids = failedAssertions.map((a) => a.id);
    return {
      allowed: false,
      grade: "FAIL",
      failedAssertionIds: ids,
      reason:
        `Harness grade is FAIL. ${ids.length} assertion(s) failed: ${ids.join(", ")}. ` +
        "Set status to in_progress and re-attempt the work or escalate to manager.",
    };
  }

  if (grade === "CONDITIONAL_PASS") {
    return {
      allowed: true,
      grade: "CONDITIONAL_PASS",
      warnings: failedAssertions.map((a) => `${a.id}: ${a.name} — ${a.detail || "failed"}`),
    };
  }

  // PASS
  return {
    allowed: true,
    grade: "PASS",
    warnings: [],
  };
}

// ── Main gate entry point ───────────────────────────────────────────

export interface CheckFailureGateOptions {
  /** Directory containing validation-harness-*.json artifacts. */
  validationDir: string;
  /** Task/issue ID for error messages. */
  taskId: string;
}

/**
 * Check whether a `done` transition is allowed for the given task.
 *
 * 1. Reads the latest harness result from `validationDir`.
 * 2. If no result exists, allows the transition (harness may not have run).
 * 3. If the latest result's `task_id` does not match `taskId`, allows
 *    the transition (stale result from a different task).
 * 4. Otherwise, evaluates the gate rules.
 */
export async function checkFailureGate(opts: CheckFailureGateOptions): Promise<FailureGateResult> {
  const result = await readLatestHarnessResult(opts.validationDir);

  // No harness result — allow (harness may not have run for this task)
  if (!result) {
    return { allowed: true, grade: "PASS", warnings: [] };
  }

  // Stale result from a different task — allow
  if (result.task_id !== opts.taskId) {
    return { allowed: true, grade: "PASS", warnings: [] };
  }

  return evaluateGate(result);
}
