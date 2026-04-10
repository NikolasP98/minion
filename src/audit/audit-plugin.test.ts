import { describe, expect, it } from "vitest";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../plugins/types.js";
import { createAuditPlugin } from "./audit-plugin.js";
import type { AuditStore } from "./audit-store.js";
import type { AuditEntry } from "./audit-types.js";

// ---------------------------------------------------------------------------
// Minimal mock store
// ---------------------------------------------------------------------------

function makeMockStore() {
  const entries: AuditEntry[] = [];
  const store: AuditStore = {
    append: async (entry: AuditEntry): Promise<void> => {
      entries.push(entry);
    },
    readRange: async (): Promise<AuditEntry[]> => [],
  } as unknown as AuditStore;
  return { store, entries };
}

// ---------------------------------------------------------------------------
// Helper: extract handlers from registrations
// ---------------------------------------------------------------------------

type BeforeHandler = (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => PluginHookBeforeToolCallResult | void;

type AfterHandler = (
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
) => void | Promise<void>;

function getHandlers(opts: Parameters<typeof createAuditPlugin>[0]) {
  const regs = createAuditPlugin(opts);
  const beforeReg = regs.find((r) => r.hookName === "before_tool_call");
  const afterReg = regs.find((r) => r.hookName === "after_tool_call");
  if (!beforeReg || !afterReg) {
    throw new Error("Missing hook registrations");
  }
  return {
    before: beforeReg.handler as unknown as BeforeHandler,
    after: afterReg.handler as unknown as AfterHandler,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuditPlugin", () => {
  it("returns two hook registrations: before_tool_call and after_tool_call", () => {
    const { store } = makeMockStore();
    const regs = createAuditPlugin({ store });

    expect(regs).toHaveLength(2);
    const names = regs.map((r) => r.hookName);
    expect(names).toContain("before_tool_call");
    expect(names).toContain("after_tool_call");
    expect(regs[0]?.pluginId).toBe("audit");
    expect(regs[0]?.source).toBe("builtin");
  });

  describe("before_tool_call", () => {
    it("does not block tool calls by default (complianceGate off)", () => {
      const { store } = makeMockStore();
      const { before } = getHandlers({ store, complianceGate: false });

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "web_search",
        params: { query: "hello world" },
      };
      const ctx: PluginHookToolContext = {
        agentId: "a1",
        sessionKey: "s1",
        toolName: "web_search",
      };

      const result = before(event, ctx);

      expect(result).toBeUndefined();
    });

    it("does not block when complianceGate is true but no violations", () => {
      const { store } = makeMockStore();
      const { before } = getHandlers({ store, complianceGate: true });

      const event: PluginHookBeforeToolCallEvent = {
        toolName: "bash",
        params: { cmd: "ls -la" },
      };
      const ctx: PluginHookToolContext = { agentId: "a1", sessionKey: "s1", toolName: "bash" };

      const result = before(event, ctx);

      // bash is local, no external transfer — no violations
      expect(result).toBeUndefined();
    });

    it("blocks unknown tool with sensitive data when complianceGate is true", () => {
      const { store } = makeMockStore();
      const { before } = getHandlers({ store, complianceGate: true });

      // Unknown tool + undeclared data categories → violations → block
      const event: PluginHookBeforeToolCallEvent = {
        toolName: "mystery_vendor_tool",
        params: { email: "user@example.com", content: "hello" },
      };
      const ctx: PluginHookToolContext = {
        agentId: "a1",
        sessionKey: "s1",
        toolName: "mystery_vendor_tool",
      };

      const result = before(event, ctx);

      expect(result?.block).toBe(true);
      expect(typeof result?.blockReason).toBe("string");
      expect((result?.blockReason ?? "").length).toBeGreaterThan(0);
    });
  });

  describe("after_tool_call", () => {
    it("calls store.append after a tool call", async () => {
      const { store, entries } = makeMockStore();
      const { before, after } = getHandlers({ store });

      const ctx: PluginHookToolContext = { agentId: "a1", sessionKey: "s1", toolName: "bash" };
      const beforeEvent: PluginHookBeforeToolCallEvent = {
        toolName: "bash",
        params: { cmd: "ls" },
      };
      const afterEvent: PluginHookAfterToolCallEvent = {
        toolName: "bash",
        params: { cmd: "ls" },
        result: "file1.txt\nfile2.txt",
        durationMs: 42,
      };

      before(beforeEvent, ctx);
      await after(afterEvent, ctx);
      // Give fire-and-forget a tick to resolve
      await Promise.resolve();

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.toolName).toBe("bash");
      expect(entry.agentId).toBe("a1");
      expect(entry.sessionKey).toBe("s1");
      expect(entry.consentScope).toBe("implicit");
      expect(Array.isArray(entry.violations)).toBe(true);
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
    });

    it("uses durationMs from event when no pending record exists", async () => {
      const { store, entries } = makeMockStore();
      const { after } = getHandlers({ store });

      // Simulate calling after without a matching before
      const ctx: PluginHookToolContext = { agentId: "a1", sessionKey: "s1", toolName: "bash" };
      const afterEvent: PluginHookAfterToolCallEvent = {
        toolName: "bash",
        params: { cmd: "ls" },
        result: "output",
        durationMs: 99,
      };

      await after(afterEvent, ctx);
      await Promise.resolve();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.durationMs).toBe(99);
    });

    it("records error field from event", async () => {
      const { store, entries } = makeMockStore();
      const { before, after } = getHandlers({ store });

      const ctx: PluginHookToolContext = {
        agentId: "a1",
        sessionKey: "s1",
        toolName: "bash",
      };
      before({ toolName: "bash", params: {} }, ctx);
      await after({ toolName: "bash", params: {}, error: "command not found", durationMs: 5 }, ctx);
      await Promise.resolve();

      expect(entries[0]?.error).toBe("command not found");
    });

    it("truncates long result summaries", async () => {
      const { store, entries } = makeMockStore();
      const { before, after } = getHandlers({ store });

      const ctx: PluginHookToolContext = { agentId: "a1", sessionKey: "s1", toolName: "bash" };
      before({ toolName: "bash", params: {} }, ctx);
      await after({ toolName: "bash", params: {}, result: "x".repeat(1000), durationMs: 1 }, ctx);
      await Promise.resolve();

      expect((entries[0]?.resultSummary ?? "").length).toBeLessThanOrEqual(200);
    });

    it("correlates before/after via FIFO queue for repeated calls to the same tool", async () => {
      const { store, entries } = makeMockStore();
      const { before, after } = getHandlers({ store });

      const ctx: PluginHookToolContext = { agentId: "a1", sessionKey: "s1", toolName: "bash" };

      before({ toolName: "bash", params: { cmd: "cmd1" } }, ctx);
      before({ toolName: "bash", params: { cmd: "cmd2" } }, ctx);

      await after({ toolName: "bash", params: { cmd: "cmd1" }, result: "r1", durationMs: 10 }, ctx);
      await after({ toolName: "bash", params: { cmd: "cmd2" }, result: "r2", durationMs: 20 }, ctx);
      await Promise.resolve();

      expect(entries).toHaveLength(2);
      // First call has durationMs calculated from pendingRecord (not event)
      // but both should have valid IDs
      expect(entries[0]?.id).toBeTruthy();
      expect(entries[1]?.id).toBeTruthy();
      expect(entries[0]?.id).not.toBe(entries[1]?.id);
    });
  });
});
