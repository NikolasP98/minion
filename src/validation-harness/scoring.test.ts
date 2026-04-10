import { describe, expect, it } from "vitest";
import { buildSummary, calculateScore, determineGrade } from "./scoring.js";
import type { AssertionResult } from "./types.js";

function makeAssertion(
  id: string,
  status: "pass" | "fail" | "skip",
  required: boolean,
  weight: number,
): AssertionResult {
  return {
    id,
    category: "test",
    name: id,
    description: "",
    required,
    status,
    detail: "",
    weight,
  };
}

describe("calculateScore", () => {
  it("returns 1.0 when all assertions pass", () => {
    const assertions = [
      makeAssertion("a", "pass", true, 1.0),
      makeAssertion("b", "pass", true, 1.0),
    ];
    expect(calculateScore(assertions)).toBeCloseTo(1.0);
  });

  it("returns 0 when all assertions fail", () => {
    const assertions = [
      makeAssertion("a", "fail", true, 1.0),
      makeAssertion("b", "fail", true, 1.0),
    ];
    expect(calculateScore(assertions)).toBeCloseTo(0);
  });

  it("excludes skipped assertions from numerator and denominator", () => {
    const assertions = [
      makeAssertion("a", "pass", true, 1.0),
      makeAssertion("b", "skip", false, 0.5),
    ];
    // Only 'a' counts: 1.0/1.0 = 1.0
    expect(calculateScore(assertions)).toBeCloseTo(1.0);
  });

  it("returns 0 when all assertions are skipped", () => {
    const assertions = [makeAssertion("a", "skip", false, 0.5)];
    expect(calculateScore(assertions)).toBeCloseTo(0);
  });

  it("uses spec example: code task with mixed results", () => {
    // 10 assertions, 2 skipped → 8 counted
    // Required (weight 1.0): 5 total, 5 pass → 5.0 contribution
    // Optional (weight 0.5): 3 total (after 2 skipped), 2 pass, 1 fail → 1.0 contribution
    // Denominator: 5×1.0 + 3×0.5 = 6.5, Numerator: 5×1.0 + 2×0.5 = 6.0
    // Score: 6.0/6.5 ≈ 0.923
    const assertions: AssertionResult[] = [
      makeAssertion("r1", "pass", true, 1.0),
      makeAssertion("r2", "pass", true, 1.0),
      makeAssertion("r3", "pass", true, 1.0),
      makeAssertion("r4", "pass", true, 1.0),
      makeAssertion("r5", "pass", true, 1.0),
      makeAssertion("o1", "pass", false, 0.5),
      makeAssertion("o2", "pass", false, 0.5),
      makeAssertion("o3", "fail", false, 0.5),
      makeAssertion("s1", "skip", false, 0.5),
      makeAssertion("s2", "skip", false, 0.5),
    ];
    expect(calculateScore(assertions)).toBeCloseTo(0.923, 2);
  });
});

describe("determineGrade", () => {
  it("returns PASS when score >= 0.85 and all required assertions pass", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    expect(determineGrade(0.9, assertions)).toBe("PASS");
  });

  it("returns FAIL when score < 0.70", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    expect(determineGrade(0.5, assertions)).toBe("FAIL");
  });

  it("returns FAIL when 2+ required assertions fail (even at high score)", () => {
    const assertions = [
      makeAssertion("r1", "fail", true, 1.0),
      makeAssertion("r2", "fail", true, 1.0),
    ];
    expect(determineGrade(0.9, assertions)).toBe("FAIL");
  });

  it("returns CONDITIONAL_PASS when score >= 0.70 and <= 1 required fails", () => {
    const assertions = [
      makeAssertion("r1", "fail", true, 1.0),
      makeAssertion("r2", "pass", true, 1.0),
    ];
    expect(determineGrade(0.75, assertions)).toBe("CONDITIONAL_PASS");
  });

  it("returns FAIL when score < 0.70 regardless of required failures", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    expect(determineGrade(0.65, assertions)).toBe("FAIL");
  });
});

describe("buildSummary", () => {
  it("builds correct summary with label", () => {
    const assertions = [
      makeAssertion("r1", "pass", true, 1.0),
      makeAssertion("r2", "pass", true, 1.0),
      makeAssertion("r3", "fail", false, 0.5),
      makeAssertion("r4", "skip", false, 0.5),
    ];
    const summary = buildSummary(assertions);
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    // non-skipped = 3, passed = 2 → "2/3 checks passed"
    expect(summary.label).toMatch(/2\/3 checks passed/);
  });

  it("includes grade in output", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    const summary = buildSummary(assertions);
    expect(["PASS", "CONDITIONAL_PASS", "FAIL"]).toContain(summary.grade);
  });
});
