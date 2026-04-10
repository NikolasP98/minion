import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFailureGate, evaluateGate, readLatestHarnessResult } from "./failure-gate.js";
import type { AssertionResult, HarnessResult } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeAssertion(
  id: string,
  status: "pass" | "fail" | "skip",
  required: boolean,
  weight = 1.0,
): AssertionResult {
  return {
    id,
    category: "test",
    name: id,
    description: `Check ${id}`,
    required,
    status,
    detail: status === "fail" ? `${id} failed` : "",
    weight,
  };
}

function makeResult(overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    schema_version: "1.0",
    task_id: "task-1",
    task_type: "code",
    generated_at: new Date().toISOString(),
    agent_id: "agent-1",
    summary: {
      total: 8,
      passed: 7,
      failed: 1,
      skipped: 0,
      score: 0.875,
      grade: "PASS",
      label: "Output Quality: 7/8 checks passed (88%)",
    },
    assertions: [
      makeAssertion("code.syntax", "pass", true),
      makeAssertion("code.runnable", "pass", true),
      makeAssertion("code.tests_pass", "pass", true),
      makeAssertion("code.generated_tests", "pass", true),
      makeAssertion("code.no_secrets", "pass", true),
      makeAssertion("code.lint", "pass", false, 0.5),
      makeAssertion("code.type_check", "pass", false, 0.5),
      makeAssertion("code.scope_bounded", "pass", true),
    ],
    ...overrides,
  };
}

// ── evaluateGate ────────────────────────────────────────────────────

describe("evaluateGate", () => {
  it("allows PASS grade with no warnings", () => {
    const result = makeResult();
    const gate = evaluateGate(result);
    expect(gate.allowed).toBe(true);
    expect(gate.grade).toBe("PASS");
    if (gate.allowed) {
      expect(gate.warnings).toHaveLength(0);
    }
  });

  it("blocks FAIL grade and cites failed assertion IDs", () => {
    const result = makeResult({
      summary: {
        total: 8,
        passed: 4,
        failed: 4,
        skipped: 0,
        score: 0.5,
        grade: "FAIL",
        label: "Output Quality: 4/8 checks passed (50%)",
      },
      assertions: [
        makeAssertion("code.syntax", "fail", true),
        makeAssertion("code.runnable", "fail", true),
        makeAssertion("code.tests_pass", "pass", true),
        makeAssertion("code.generated_tests", "pass", true),
        makeAssertion("code.no_secrets", "pass", true),
        makeAssertion("code.lint", "fail", false, 0.5),
        makeAssertion("code.type_check", "fail", false, 0.5),
        makeAssertion("code.scope_bounded", "pass", true),
      ],
    });

    const gate = evaluateGate(result);
    expect(gate.allowed).toBe(false);
    expect(gate.grade).toBe("FAIL");
    if (!gate.allowed) {
      expect(gate.failedAssertionIds).toContain("code.syntax");
      expect(gate.failedAssertionIds).toContain("code.runnable");
      expect(gate.failedAssertionIds).toContain("code.lint");
      expect(gate.failedAssertionIds).toContain("code.type_check");
      expect(gate.failedAssertionIds).toHaveLength(4);
      expect(gate.reason).toContain("FAIL");
      expect(gate.reason).toContain("code.syntax");
    }
  });

  it("allows CONDITIONAL_PASS with warnings listing failed assertions", () => {
    const result = makeResult({
      summary: {
        total: 8,
        passed: 6,
        failed: 2,
        skipped: 0,
        score: 0.75,
        grade: "CONDITIONAL_PASS",
        label: "Output Quality: 6/8 checks passed (75%)",
      },
      assertions: [
        makeAssertion("code.syntax", "pass", true),
        makeAssertion("code.runnable", "pass", true),
        makeAssertion("code.tests_pass", "pass", true),
        makeAssertion("code.generated_tests", "pass", true),
        makeAssertion("code.no_secrets", "pass", true),
        makeAssertion("code.lint", "fail", false, 0.5),
        makeAssertion("code.type_check", "fail", false, 0.5),
        makeAssertion("code.scope_bounded", "pass", true),
      ],
    });

    const gate = evaluateGate(result);
    expect(gate.allowed).toBe(true);
    expect(gate.grade).toBe("CONDITIONAL_PASS");
    if (gate.allowed) {
      expect(gate.warnings).toHaveLength(2);
      expect(gate.warnings[0]).toContain("code.lint");
      expect(gate.warnings[1]).toContain("code.type_check");
    }
  });

  it("FAIL reason includes instruction to set status to in_progress", () => {
    const result = makeResult({
      summary: {
        total: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
        score: 0,
        grade: "FAIL",
        label: "Output Quality: 0/2 checks passed (0%)",
      },
      assertions: [
        makeAssertion("code.syntax", "fail", true),
        makeAssertion("code.runnable", "fail", true),
      ],
    });

    const gate = evaluateGate(result);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toContain("in_progress");
      expect(gate.reason).toContain("escalate");
    }
  });
});

// ── readLatestHarnessResult (filesystem) ────────────────────────────

describe("readLatestHarnessResult", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "failure-gate-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent directory", async () => {
    const result = await readLatestHarnessResult(path.join(tmpDir, "nope"));
    expect(result).toBeNull();
  });

  it("returns null for empty directory", async () => {
    const result = await readLatestHarnessResult(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when no matching files exist", async () => {
    await fs.writeFile(path.join(tmpDir, "other-file.json"), "{}");
    const result = await readLatestHarnessResult(tmpDir);
    expect(result).toBeNull();
  });

  it("reads a single harness result", async () => {
    const harnessResult = makeResult({ task_id: "task-a" });
    await fs.writeFile(
      path.join(tmpDir, "validation-harness-task-a.json"),
      JSON.stringify(harnessResult),
    );
    const result = await readLatestHarnessResult(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.task_id).toBe("task-a");
  });

  it("returns the most recent result by generated_at", async () => {
    const older = makeResult({
      task_id: "task-old",
      generated_at: "2026-04-10T10:00:00.000Z",
    });
    const newer = makeResult({
      task_id: "task-new",
      generated_at: "2026-04-10T12:00:00.000Z",
    });
    await fs.writeFile(
      path.join(tmpDir, "validation-harness-task-old.json"),
      JSON.stringify(older),
    );
    await fs.writeFile(
      path.join(tmpDir, "validation-harness-task-new.json"),
      JSON.stringify(newer),
    );
    const result = await readLatestHarnessResult(tmpDir);
    expect(result!.task_id).toBe("task-new");
  });

  it("skips malformed JSON files", async () => {
    await fs.writeFile(path.join(tmpDir, "validation-harness-bad.json"), "not valid json {{{");
    const good = makeResult({ task_id: "good" });
    await fs.writeFile(path.join(tmpDir, "validation-harness-good.json"), JSON.stringify(good));
    const result = await readLatestHarnessResult(tmpDir);
    expect(result!.task_id).toBe("good");
  });

  it("skips files with wrong schema_version", async () => {
    const wrongSchema = { ...makeResult(), schema_version: "2.0" };
    await fs.writeFile(
      path.join(tmpDir, "validation-harness-wrong.json"),
      JSON.stringify(wrongSchema),
    );
    const result = await readLatestHarnessResult(tmpDir);
    expect(result).toBeNull();
  });
});

// ── checkFailureGate (integration) ──────────────────────────────────

describe("checkFailureGate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "failure-gate-int-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows transition when no harness results exist", async () => {
    const gate = await checkFailureGate({
      validationDir: path.join(tmpDir, "missing"),
      taskId: "task-1",
    });
    expect(gate.allowed).toBe(true);
  });

  it("allows transition when latest result is for a different task", async () => {
    const result = makeResult({
      task_id: "other-task",
      summary: {
        total: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
        score: 0,
        grade: "FAIL",
        label: "Output Quality: 0/2 checks passed (0%)",
      },
      assertions: [
        makeAssertion("code.syntax", "fail", true),
        makeAssertion("code.runnable", "fail", true),
      ],
    });
    await fs.writeFile(
      path.join(tmpDir, "validation-harness-other-task.json"),
      JSON.stringify(result),
    );
    const gate = await checkFailureGate({ validationDir: tmpDir, taskId: "my-task" });
    expect(gate.allowed).toBe(true);
  });

  it("blocks done transition when harness grade=FAIL for matching task", async () => {
    const result = makeResult({
      task_id: "task-1",
      summary: {
        total: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
        score: 0,
        grade: "FAIL",
        label: "Output Quality: 0/2 checks passed (0%)",
      },
      assertions: [
        makeAssertion("code.syntax", "fail", true),
        makeAssertion("code.runnable", "fail", true),
      ],
    });
    await fs.writeFile(path.join(tmpDir, "validation-harness-task-1.json"), JSON.stringify(result));

    const gate = await checkFailureGate({ validationDir: tmpDir, taskId: "task-1" });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.grade).toBe("FAIL");
      expect(gate.failedAssertionIds).toContain("code.syntax");
      expect(gate.failedAssertionIds).toContain("code.runnable");
      expect(gate.reason).toContain("FAIL");
    }
  });

  it("allows done transition with warnings for CONDITIONAL_PASS", async () => {
    const result = makeResult({
      task_id: "task-1",
      summary: {
        total: 8,
        passed: 6,
        failed: 2,
        skipped: 0,
        score: 0.75,
        grade: "CONDITIONAL_PASS",
        label: "Output Quality: 6/8 checks passed (75%)",
      },
      assertions: [
        makeAssertion("code.syntax", "pass", true),
        makeAssertion("code.runnable", "pass", true),
        makeAssertion("code.tests_pass", "pass", true),
        makeAssertion("code.generated_tests", "pass", true),
        makeAssertion("code.no_secrets", "pass", true),
        makeAssertion("code.lint", "fail", false, 0.5),
        makeAssertion("code.type_check", "fail", false, 0.5),
        makeAssertion("code.scope_bounded", "pass", true),
      ],
    });
    await fs.writeFile(path.join(tmpDir, "validation-harness-task-1.json"), JSON.stringify(result));

    const gate = await checkFailureGate({ validationDir: tmpDir, taskId: "task-1" });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) {
      expect(gate.grade).toBe("CONDITIONAL_PASS");
      expect(gate.warnings.length).toBeGreaterThan(0);
    }
  });

  it("allows done transition for PASS grade", async () => {
    const result = makeResult({ task_id: "task-1" });
    await fs.writeFile(path.join(tmpDir, "validation-harness-task-1.json"), JSON.stringify(result));

    const gate = await checkFailureGate({ validationDir: tmpDir, taskId: "task-1" });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) {
      expect(gate.grade).toBe("PASS");
      expect(gate.warnings).toHaveLength(0);
    }
  });
});
