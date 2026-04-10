/**
 * Unit tests for the compliance report generator.
 */

import { describe, expect, it } from "vitest";
import type { AuditEntry } from "./audit-types.js";
import { formatComplianceReport, generateComplianceReport } from "./compliance-report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: overrides.id ?? "entry-1",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    toolName: overrides.toolName ?? "bash",
    params: overrides.params ?? {},
    paramCategories: overrides.paramCategories ?? [],
    consentScope: overrides.consentScope ?? "implicit",
    violations: overrides.violations ?? [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateComplianceReport", () => {
  const periodStart = new Date("2026-04-01T00:00:00Z");
  const periodEnd = new Date("2026-04-30T23:59:59Z");

  it("counts total tool calls correctly", () => {
    const entries = [makeEntry(), makeEntry(), makeEntry()];
    const report = generateComplianceReport(entries, periodStart, periodEnd);
    expect(report.totalToolCalls).toBe(3);
  });

  it("counts violations and groups by type", () => {
    const entries = [
      makeEntry({
        id: "e1",
        violations: [{ type: "unknown_tool", detail: "test" }],
      }),
      makeEntry({
        id: "e2",
        violations: [
          { type: "undeclared_data_category", detail: "test" },
          { type: "unknown_tool", detail: "test" },
        ],
      }),
      makeEntry({ id: "e3", violations: [] }),
    ];

    const report = generateComplianceReport(entries, periodStart, periodEnd);

    expect(report.violationCount).toBe(2);
    expect(report.violationsByType["unknown_tool"]).toBe(2);
    expect(report.violationsByType["undeclared_data_category"]).toBe(1);
  });

  it("tracks external transfers from violation types", () => {
    const entries = [
      makeEntry({
        toolName: "vendor_crm",
        violations: [{ type: "unknown_tool", detail: "unknown vendor" }],
      }),
      makeEntry({
        toolName: "external_api",
        violations: [{ type: "external_transfer_without_consent", detail: "no consent" }],
      }),
      makeEntry({ toolName: "bash", violations: [] }),
    ];

    const report = generateComplianceReport(entries, periodStart, periodEnd);

    expect(report.externalTransfers).toBe(2);
    expect(report.externalTransferTools).toContain("vendor_crm");
    expect(report.externalTransferTools).toContain("external_api");
    expect(report.externalTransferTools).not.toContain("bash");
  });

  it("collects data categories from params and results", () => {
    const entries = [
      makeEntry({
        paramCategories: ["user_content", "user_identity"],
        resultCategories: ["metadata"],
      }),
      makeEntry({
        paramCategories: ["credentials"],
        resultCategories: ["tool_output"],
      }),
    ];

    const report = generateComplianceReport(entries, periodStart, periodEnd);

    expect(report.dataCategories).toContain("user_content");
    expect(report.dataCategories).toContain("user_identity");
    expect(report.dataCategories).toContain("metadata");
    expect(report.dataCategories).toContain("credentials");
    expect(report.dataCategories).toContain("tool_output");
  });

  it("breaks down tool calls by tool name", () => {
    const entries = [
      makeEntry({ toolName: "bash" }),
      makeEntry({ toolName: "bash" }),
      makeEntry({ toolName: "web_search" }),
    ];

    const report = generateComplianceReport(entries, periodStart, periodEnd);

    expect(report.toolCallsByTool["bash"]).toBe(2);
    expect(report.toolCallsByTool["web_search"]).toBe(1);
  });

  it("handles empty entries array", () => {
    const report = generateComplianceReport([], periodStart, periodEnd);

    expect(report.totalToolCalls).toBe(0);
    expect(report.externalTransfers).toBe(0);
    expect(report.violationCount).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.dataCategories).toEqual([]);
    expect(report.externalTransferTools).toEqual([]);
    expect(Object.keys(report.toolCallsByTool)).toHaveLength(0);
  });

  it("includes period and generation timestamps", () => {
    const report = generateComplianceReport([], periodStart, periodEnd);

    expect(report.periodStart).toBe(periodStart.toISOString());
    expect(report.periodEnd).toBe(periodEnd.toISOString());
    expect(report.generatedAt).toBeTruthy();
  });

  it("includes violation entry references with correct fields", () => {
    const entries = [
      makeEntry({
        id: "entry-abc",
        timestamp: "2026-04-10T12:00:00Z",
        toolName: "mystery_tool",
        violations: [
          { type: "unknown_tool", detail: "no declaration" },
          { type: "undeclared_data_category", detail: "user_identity not declared" },
        ],
      }),
    ];

    const report = generateComplianceReport(entries, periodStart, periodEnd);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.entryId).toBe("entry-abc");
    expect(report.violations[0]?.timestamp).toBe("2026-04-10T12:00:00Z");
    expect(report.violations[0]?.toolName).toBe("mystery_tool");
    expect(report.violations[0]?.violations).toHaveLength(2);
  });
});

describe("formatComplianceReport", () => {
  it("produces valid markdown with all sections", () => {
    const entries = [
      makeEntry({
        toolName: "web_search",
        paramCategories: ["user_content"],
        violations: [{ type: "unknown_tool", detail: "test detail" }],
      }),
    ];

    const report = generateComplianceReport(
      entries,
      new Date("2026-04-01"),
      new Date("2026-04-30"),
    );
    const md = formatComplianceReport(report);

    expect(md).toContain("# Compliance Report — EU AI Act Article 50");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Tool Call Breakdown");
    expect(md).toContain("## Data Categories Processed");
    expect(md).toContain("## Violations");
    expect(md).toContain("## Violation Summary by Type");
    expect(md).toContain("web_search");
    expect(md).toContain("unknown_tool");
    expect(md).toContain("Total tool calls | 1");
  });

  it("omits empty sections", () => {
    const report = generateComplianceReport([], new Date("2026-04-01"), new Date("2026-04-30"));
    const md = formatComplianceReport(report);

    expect(md).toContain("## Summary");
    expect(md).not.toContain("## Tool Call Breakdown");
    expect(md).not.toContain("## Violations");
    expect(md).not.toContain("## External Transfer Tools");
  });
});
