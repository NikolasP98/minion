import type { AssertionResult, Grade, HarnessSummary } from "./types.js";

/**
 * score = sum(weight for passing assertions) / sum(weight for non-skipped assertions)
 * Per spec Section 4.
 */
export function calculateScore(assertions: AssertionResult[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const a of assertions) {
    if (a.status === "skip") {
      continue;
    }
    denominator += a.weight;
    if (a.status === "pass") {
      numerator += a.weight;
    }
  }
  if (denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

/**
 * Grade thresholds per spec Section 2.1:
 * - PASS: score >= 0.85 AND all required assertions pass
 * - CONDITIONAL_PASS: score >= 0.70 AND no more than 1 required assertion fails
 * - FAIL: score < 0.70 OR any 2+ required assertions fail
 */
export function determineGrade(score: number, assertions: AssertionResult[]): Grade {
  const requiredFails = assertions.filter((a) => a.required && a.status === "fail").length;

  if (requiredFails >= 2 || score < 0.7) {
    return "FAIL";
  }
  if (score >= 0.85 && requiredFails === 0) {
    return "PASS";
  }
  return "CONDITIONAL_PASS";
}

/** Build the summary object from assertion results. */
export function buildSummary(assertions: AssertionResult[]): HarnessSummary {
  const passed = assertions.filter((a) => a.status === "pass").length;
  const failed = assertions.filter((a) => a.status === "fail").length;
  const skipped = assertions.filter((a) => a.status === "skip").length;
  const total = assertions.length;
  const nonSkipped = total - skipped;
  const score = calculateScore(assertions);
  const grade = determineGrade(score, assertions);
  const pct = Math.round(score * 100);
  const label = `Output Quality: ${passed}/${nonSkipped} checks passed (${pct}%)`;

  return { total, passed, failed, skipped, score, grade, label };
}
