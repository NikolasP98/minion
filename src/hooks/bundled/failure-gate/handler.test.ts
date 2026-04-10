import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssertionResult, HarnessResult } from "../../../validation-harness/types.js";
import type { InternalHookEvent } from "../../internal-hooks.js";
import failureGateHandler from "./handler.js";

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

function makeHarnessResult(overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    schema_version: "1.0",
    task_id: "task-1",
    task_type: "code",
    generated_at: new Date().toISOString(),
    agent_id: "agent-1",
    summary: {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      score: 1.0,
      grade: "PASS",
      label: "Output Quality: 2/2 checks passed (100%)",
    },
    assertions: [
      makeAssertion("code.syntax", "pass", true),
      makeAssertion("code.runnable", "pass", true),
    ],
    ...overrides,
  };
}

function makeEvent(contextOverrides: Record<string, unknown> = {}): InternalHookEvent {
  return {
    type: "agent",
    action: "task_completing",
    sessionKey: "test-session",
    context: {
      taskId: "task-1",
      targetStatus: "done",
      validationDir: "/tmp/does-not-exist",
      ...contextOverrides,
    },
    timestamp: new Date(),
    messages: [],
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("failure-gate handler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-handler-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ignores non agent:task_completing events", async () => {
    const event = makeEvent();
    event.type = "message";
    event.action = "sent";
    await failureGateHandler(event);
    expect(event.messages).toHaveLength(0);
  });

  it("ignores transitions to statuses other than done", async () => {
    const event = makeEvent({ targetStatus: "in_progress", validationDir: tmpDir });
    await failureGateHandler(event);
    expect(event.messages).toHaveLength(0);
    expect(event.context.blocked).toBeUndefined();
  });

  it("allows done transition when no harness results exist", async () => {
    const event = makeEvent({ validationDir: path.join(tmpDir, "empty") });
    await failureGateHandler(event);
    expect(event.messages).toHaveLength(0);
    expect(event.context.blocked).toBeUndefined();
  });

  it("blocks done transition when grade=FAIL", async () => {
    const result = makeHarnessResult({
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

    const event = makeEvent({ validationDir: tmpDir });
    await failureGateHandler(event);

    const ctx = event.context;
    expect(ctx.blocked).toBe(true);
    expect(ctx.blockReason).toContain("FAIL");
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0]).toContain("blocked");
    expect(event.messages[0]).toContain("code.syntax");
    expect(event.messages[0]).toContain("code.runnable");
  });

  it("allows done transition with warnings for CONDITIONAL_PASS", async () => {
    const result = makeHarnessResult({
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

    const event = makeEvent({ validationDir: tmpDir });
    await failureGateHandler(event);

    const ctx = event.context;
    expect(ctx.blocked).toBeUndefined();
    expect(ctx.warnings).toHaveLength(2);
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0]).toContain("CONDITIONAL_PASS");
  });

  it("allows done transition silently for PASS", async () => {
    const result = makeHarnessResult({ task_id: "task-1" });
    await fs.writeFile(path.join(tmpDir, "validation-harness-task-1.json"), JSON.stringify(result));

    const event = makeEvent({ validationDir: tmpDir });
    await failureGateHandler(event);

    const ctx = event.context;
    expect(ctx.blocked).toBeUndefined();
    expect(event.messages).toHaveLength(0);
  });

  it("ignores events with missing context fields", async () => {
    const event = makeEvent({});
    // Remove required fields
    delete event.context.taskId;
    await failureGateHandler(event);
    expect(event.messages).toHaveLength(0);
  });
});
