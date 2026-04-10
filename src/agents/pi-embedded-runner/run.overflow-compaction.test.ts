import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      },
    });

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "overflow",
        authProfileId: "test-profile",
      }),
    );
  });

  it("surfaces context overflow error when compaction rejects empty session state", async () => {
    // Simulates the scenario described in MIN-398: compaction fires mid-loop but
    // produces an empty or assistant-free session, triggering the empty-session guard
    // which returns compacted=false. The runner must NOT continue the loop silently;
    // it must surface a context overflow error instead.
    const overflowError = new Error("context window exceeded");

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: overflowError }),
    );

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason:
        "compaction produced empty or assistant-free session state (messages=0, hasAssistant=false)",
    });

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // Runner should surface a context overflow error, not loop forever with empty context.
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    // After compaction fails, the runner must NOT retry another attempt with a wiped session.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry prompt after compaction rejects mid-loop empty session", async () => {
    // Verifies that a compacted=false result from the empty-session guard does not
    // cause a second runEmbeddedAttempt call (which would load the wiped session file).
    const overflowError = new Error("request_too_large: context window exceeded");

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: overflowError }),
    );

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason:
        "compaction produced empty or assistant-free session state (messages=1, hasAssistant=false)",
    });

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // runEmbeddedAttempt must be called exactly once — not again after compaction failure.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
