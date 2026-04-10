import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { checkCommandAutonomy } from "../security/autonomy-enforcement.js";
import {
  detectTruncatedToolCall,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { CRITICAL_THRESHOLD, GLOBAL_CIRCUIT_BREAKER_THRESHOLD } from "./tool-loop-detection.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../plugins/hook-runner-global.js");
vi.mock("../security/autonomy-enforcement.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCheckCommandAutonomy = vi.mocked(checkCommandAutonomy);

describe("before_tool_call loop detection behavior", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };
  const enabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: true },
  };

  const disabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: false },
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    hookRunner.hasHooks.mockReturnValue(false);
    mockCheckCommandAutonomy.mockReturnValue(null);
  });

  function createWrappedTool(
    name: string,
    execute: ReturnType<typeof vi.fn>,
    loopDetectionContext = enabledLoopDetectionContext,
  ) {
    return wrapToolWithBeforeToolCallHook(
      { name, execute } as unknown as AnyAgentTool,
      loopDetectionContext,
    );
  }

  async function withToolLoopEvents(
    run: (emitted: DiagnosticToolLoopEvent[]) => Promise<void>,
    filter: (evt: DiagnosticToolLoopEvent) => boolean = () => true,
  ) {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop" && filter(evt)) {
        emitted.push(evt);
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  function createPingPongTools(options?: { withProgress?: boolean }) {
    const readExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `read ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "read ok" }],
          details: { ok: true },
        });
    const listExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `list ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "list ok" }],
          details: { ok: true },
        });
    return {
      readTool: createWrappedTool("read", readExecute),
      listTool: createWrappedTool("list", listExecute),
    };
  }

  async function runPingPongSequence(
    readTool: ReturnType<typeof createWrappedTool>,
    listTool: ReturnType<typeof createWrappedTool>,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
      } else {
        await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
      }
    }
  }
  it("blocks known poll loops when no progress repeats", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    const tool = createWrappedTool("process", execute);
    const params = { action: "poll", sessionId: "sess-1" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expect(tool.execute(`poll-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }

    await expect(
      tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined),
    ).rejects.toThrow("CRITICAL");
  });

  it("does nothing when loopDetection.enabled is false", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "process", execute } as any, {
      ...disabledLoopDetectionContext,
    });
    const params = { action: "poll", sessionId: "sess-off" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expect(tool.execute(`poll-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }
  });

  it("does not block known poll loops when output progresses", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string) => {
      return {
        content: [{ type: "text", text: `output ${toolCallId}` }],
        details: { status: "running", aggregated: `output ${toolCallId}` },
      };
    });
    const tool = createWrappedTool("process", execute);
    const params = { action: "poll", sessionId: "sess-2" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expect(
        tool.execute(`poll-progress-${i}`, params, undefined, undefined),
      ).resolves.toBeDefined();
    }
  });

  it("keeps generic repeated calls warn-only below global breaker", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    const tool = createWrappedTool("read", execute);
    const params = { path: "/tmp/file" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expect(tool.execute(`read-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }
  });

  it("blocks generic repeated no-progress calls at global breaker threshold", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    const tool = createWrappedTool("read", execute);
    const params = { path: "/tmp/file" };

    for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      await expect(tool.execute(`read-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }

    await expect(
      tool.execute(`read-${GLOBAL_CIRCUIT_BREAKER_THRESHOLD}`, params, undefined, undefined),
    ).rejects.toThrow("global circuit breaker");
  });

  it("coalesces repeated generic warning events into threshold buckets", async () => {
    await withToolLoopEvents(
      async (emitted) => {
        const execute = vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "same output" }],
          details: { ok: true },
        });
        const tool = createWrappedTool("read", execute);
        const params = { path: "/tmp/file" };

        for (let i = 0; i < 21; i += 1) {
          await tool.execute(`read-bucket-${i}`, params, undefined, undefined);
        }

        const genericWarns = emitted.filter((evt) => evt.detector === "generic_repeat");
        expect(genericWarns.map((evt) => evt.count)).toEqual([10, 20]);
      },
      (evt) => evt.level === "warning",
    );
  });

  it("emits structured warning diagnostic events for ping-pong loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, 9);

      await listTool.execute("list-9", { dir: "/workspace" }, undefined, undefined);
      await readTool.execute("read-10", { path: "/a.txt" }, undefined, undefined);
      await listTool.execute("list-11", { dir: "/workspace" }, undefined, undefined);

      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const loopEvent = pingPongWarns[0];
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("warning");
      expect(loopEvent?.action).toBe("warn");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(10);
      expect(loopEvent?.toolName).toBe("list");
    });
  });

  it("blocks ping-pong loops at critical threshold and emits critical diagnostic events", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expect(
        listTool.execute(
          `list-${CRITICAL_THRESHOLD - 1}`,
          { dir: "/workspace" },
          undefined,
          undefined,
        ),
      ).rejects.toThrow("CRITICAL");

      const loopEvent = emitted.at(-1);
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("critical");
      expect(loopEvent?.action).toBe("block");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(CRITICAL_THRESHOLD);
      expect(loopEvent?.toolName).toBe("list");
    });
  });

  it("does not block ping-pong at critical threshold when outcomes are progressing", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools({ withProgress: true });
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expect(
        listTool.execute(
          `list-${CRITICAL_THRESHOLD - 1}`,
          { dir: "/workspace" },
          undefined,
          undefined,
        ),
      ).resolves.toBeDefined();

      const criticalPingPong = emitted.find(
        (evt) => evt.level === "critical" && evt.detector === "ping_pong",
      );
      expect(criticalPingPong).toBeUndefined();
      const warningPingPong = emitted.find(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(warningPingPong).toBeTruthy();
    });
  });

  it("emits structured critical diagnostic events when blocking loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const execute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
        details: { status: "running", aggregated: "steady" },
      });
      const tool = createWrappedTool("process", execute);
      const params = { action: "poll", sessionId: "sess-crit" };

      for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
        await tool.execute(`poll-${i}`, params, undefined, undefined);
      }

      await expect(
        tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined),
      ).rejects.toThrow("CRITICAL");

      const loopEvent = emitted.at(-1);
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("critical");
      expect(loopEvent?.action).toBe("block");
      expect(loopEvent?.detector).toBe("known_poll_no_progress");
      expect(loopEvent?.count).toBe(CRITICAL_THRESHOLD);
      expect(loopEvent?.toolName).toBe("process");
    });
  });
});

describe("autonomy enforcement wiring", () => {
  beforeEach(() => {
    mockCheckCommandAutonomy.mockReset();
    mockGetGlobalHookRunner.mockReturnValue(null);
  });

  it("blocks tool call when autonomy check returns blocked", async () => {
    mockCheckCommandAutonomy.mockReturnValue({
      blocked: true,
      reason: "Command 'rm -rf /' blocked by readonly mode",
    });

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "rm -rf /" },
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome).toHaveProperty("reason");
    if (outcome.blocked) {
      expect(outcome.reason).toContain("readonly mode");
    }
  });

  it("allows tool call when autonomy check returns not blocked", async () => {
    mockCheckCommandAutonomy.mockReturnValue({ blocked: false });

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hello" },
    });

    expect(outcome.blocked).toBe(false);
  });

  it("allows tool call when autonomy check returns null (non-exec tool)", async () => {
    mockCheckCommandAutonomy.mockReturnValue(null);

    const outcome = await runBeforeToolCallHook({
      toolName: "read_file",
      params: { path: "/tmp/file.txt" },
    });

    expect(outcome.blocked).toBe(false);
  });

  it("passes config from hook context to autonomy check", async () => {
    mockCheckCommandAutonomy.mockReturnValue(null);

    const config = { security: { level: "readonly" as const } };
    await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      ctx: { config: config as never },
    });

    expect(mockCheckCommandAutonomy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        config,
      }),
    );
  });
});

describe("detectTruncatedToolCall", () => {
  it("returns null for a normal tool call with object params", () => {
    expect(detectTruncatedToolCall("bash", { command: "ls" })).toBeNull();
  });

  it("returns null for a tool call with no params (empty object)", () => {
    expect(detectTruncatedToolCall("bash", {})).toBeNull();
  });

  it("returns null for a tool call with null params", () => {
    expect(detectTruncatedToolCall("read", null)).toBeNull();
  });

  it("returns a reason string when tool name is empty", () => {
    const reason = detectTruncatedToolCall("", { path: "/foo" });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/empty function name/);
  });

  it("returns a reason string when tool name is whitespace-only", () => {
    const reason = detectTruncatedToolCall("   ", { path: "/foo" });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/empty function name/);
  });

  it("returns a reason string when params is a partial JSON string", () => {
    const reason = detectTruncatedToolCall("read", '{"path": "/some/fi');
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/partial JSON string/);
  });

  it("returns null when params is a valid JSON string", () => {
    // Unusual but valid: SDK may pass args as a serialized string in some providers
    expect(detectTruncatedToolCall("read", '{"path": "/some/file"}')).toBeNull();
  });

  it("returns null when params is an empty string (treated as no args)", () => {
    expect(detectTruncatedToolCall("ping", "")).toBeNull();
  });
});

describe("runBeforeToolCallHook — truncation guard", () => {
  beforeEach(() => {
    vi.mocked(getGlobalHookRunner).mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    } as never);
    vi.mocked(checkCommandAutonomy).mockReturnValue(null);
  });

  it("blocks tool calls with an empty name", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "",
      params: { path: "/foo" },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toMatch(/empty function name/);
    }
  });

  it("blocks tool calls when params is a partial JSON string", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "read",
      params: '{"path": "/some/fi',
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toMatch(/partial JSON string/);
    }
  });

  it("does not block normal tool calls", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "ls" },
    });
    expect(result.blocked).toBe(false);
  });
});
