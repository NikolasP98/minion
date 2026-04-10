/**
 * E2E test: Full audit pipeline — tool calls → JSONL store → compliance report.
 *
 * Simulates a mock agent loop with 5 tool calls (mix of local + third-party),
 * verifies the JSONL audit log is written correctly, generates a compliance
 * report, and validates the report metrics.
 *
 * EU AI Act Article 50 — end-to-end audit trail validation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../plugins/types.js";
import { createAuditPlugin } from "./audit-plugin.js";
import { AuditStore, createAuditStore } from "./audit-store.js";
import type { AuditEntry } from "./audit-types.js";
import { generateComplianceReport, formatComplianceReport } from "./compliance-report.js";

// ---------------------------------------------------------------------------
// Helpers
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

/** Simulate a tool call through the audit plugin hooks. */
async function simulateToolCall(
  handlers: { before: BeforeHandler; after: AfterHandler },
  ctx: PluginHookToolContext,
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
  durationMs: number,
  error?: string,
): Promise<PluginHookBeforeToolCallResult | void> {
  const beforeResult = handlers.before({ toolName, params }, ctx);
  await handlers.after({ toolName, params, result, error, durationMs }, ctx);
  return beforeResult;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Full audit pipeline E2E", () => {
  let tmpDir: string;
  let store: AuditStore;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "audit-pipeline-e2e-"));
    store = createAuditStore({ dir: tmpDir, enabled: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("records 5 tool calls to JSONL and generates accurate compliance report", async () => {
    const handlers = getHandlers({ store, complianceGate: false });
    const ctx: PluginHookToolContext = {
      agentId: "agent-pipeline",
      sessionKey: "session-e2e-001",
      toolName: "", // overridden per call
    };

    // --- Tool call 1: local bash (no violations) ---
    await simulateToolCall(
      handlers,
      { ...ctx, toolName: "bash" },
      "bash",
      { cmd: "ls -la /home" },
      "total 4\ndrwxr-xr-x 2 user user 4096 ...",
      15,
    );

    // --- Tool call 2: local read_file (no violations) ---
    await simulateToolCall(
      handlers,
      { ...ctx, toolName: "read_file" },
      "read_file",
      { file: "/etc/hostname" },
      "minion-server",
      8,
    );

    // --- Tool call 3: third-party web_search (no violations — query matches declared categories) ---
    await simulateToolCall(
      handlers,
      { ...ctx, toolName: "web_search" },
      "web_search",
      { query: "EU AI Act Article 50 requirements" },
      { results: [{ title: "EU AI Act", url: "https://example.com" }] },
      230,
    );

    // --- Tool call 4: unknown third-party tool (violations: unknown_tool + undeclared_data_category) ---
    await simulateToolCall(
      handlers,
      { ...ctx, toolName: "vendor_analytics" },
      "vendor_analytics",
      { user_id: "u-999", email: "bob@acme.com", content: "Track user behaviour" },
      { status: "tracked" },
      45,
    );

    // --- Tool call 5: local bash with error (no violations) ---
    await simulateToolCall(
      handlers,
      { ...ctx, toolName: "bash" },
      "bash",
      { cmd: "cat /nonexistent" },
      undefined,
      5,
      "No such file or directory",
    );

    // Wait for fire-and-forget store.append calls to complete
    await new Promise((r) => setTimeout(r, 100));

    // --- Verify JSONL log ---
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, `audit-${today}.jsonl`);
    const content = await fs.promises.readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(5);

    const entries: AuditEntry[] = lines.map((l) => JSON.parse(l) as AuditEntry);

    // Verify each entry has required fields
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.agentId).toBe("agent-pipeline");
      expect(entry.sessionKey).toBe("session-e2e-001");
      expect(entry.toolName).toBeTruthy();
      expect(Array.isArray(entry.paramCategories)).toBe(true);
      expect(entry.consentScope).toBe("implicit");
      expect(Array.isArray(entry.violations)).toBe(true);
    }

    // Verify tool names
    const toolNames = entries.map((e) => e.toolName);
    expect(toolNames).toEqual(["bash", "read_file", "web_search", "vendor_analytics", "bash"]);

    // Verify the error entry
    const errorEntry = entries[4];
    expect(errorEntry.error).toBe("No such file or directory");

    // Verify vendor_analytics has violations
    const vendorEntry = entries[3];
    expect(vendorEntry.violations.length).toBeGreaterThan(0);
    const violationTypes = vendorEntry.violations.map((v) => v.type);
    expect(violationTypes).toContain("unknown_tool");
    expect(violationTypes).toContain("undeclared_data_category");

    // --- Generate compliance report ---
    const now = new Date();
    const periodStart = new Date(now.getTime() - 60_000);
    const periodEnd = new Date(now.getTime() + 60_000);

    const readEntries = await store.readRange(periodStart, periodEnd);
    expect(readEntries).toHaveLength(5);

    const report = generateComplianceReport(readEntries, periodStart, periodEnd);

    // Verify report metrics
    expect(report.totalToolCalls).toBe(5);
    expect(report.externalTransfers).toBe(1); // vendor_analytics (unknown tool = conservative external)
    expect(report.violationCount).toBe(1); // only vendor_analytics has violations
    expect(report.toolCallsByTool["bash"]).toBe(2);
    expect(report.toolCallsByTool["read_file"]).toBe(1);
    expect(report.toolCallsByTool["web_search"]).toBe(1);
    expect(report.toolCallsByTool["vendor_analytics"]).toBe(1);
    expect(report.violationsByType["unknown_tool"]).toBe(1);
    expect(report.violationsByType["undeclared_data_category"]).toBe(1);
    expect(report.externalTransferTools).toContain("vendor_analytics");
    expect(report.dataCategories.length).toBeGreaterThan(0);

    // Verify violation details reference the correct entry
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.toolName).toBe("vendor_analytics");
    expect(report.violations[0]?.entryId).toBe(vendorEntry.id);

    // --- Verify formatted report is valid markdown ---
    const markdown = formatComplianceReport(report);
    expect(markdown).toContain("# Compliance Report");
    expect(markdown).toContain("Total tool calls | 5");
    expect(markdown).toContain("External transfers | 1");
    expect(markdown).toContain("vendor_analytics");
    expect(markdown).toContain("unknown_tool");
  });

  it("handles empty audit log gracefully", () => {
    const periodStart = new Date("2026-01-01");
    const periodEnd = new Date("2026-01-31");
    const report = generateComplianceReport([], periodStart, periodEnd);

    expect(report.totalToolCalls).toBe(0);
    expect(report.externalTransfers).toBe(0);
    expect(report.violationCount).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.dataCategories).toEqual([]);
    expect(report.externalTransferTools).toEqual([]);

    const markdown = formatComplianceReport(report);
    expect(markdown).toContain("Total tool calls | 0");
  });

  it("generates report with correct data categories from params and results", async () => {
    const handlers = getHandlers({ store, complianceGate: false });
    const ctx: PluginHookToolContext = {
      agentId: "agent-cat",
      sessionKey: "session-cat",
      toolName: "memory_store",
    };

    await simulateToolCall(
      handlers,
      ctx,
      "memory_store",
      { content: "user note", name: "Alice", email: "alice@example.com" },
      { stored: true, id: "mem-1" },
      20,
    );
    await new Promise((r) => setTimeout(r, 50));

    const entries = await store.readRange(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    expect(entries).toHaveLength(1);

    const report = generateComplianceReport(
      entries,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );

    // memory_store with name/email params → user_identity + user_content
    expect(report.dataCategories).toContain("user_identity");
    expect(report.dataCategories).toContain("user_content");
  });
});
