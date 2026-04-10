/**
 * Compliance report generator for AudAgent.
 *
 * Produces structured compliance reports from AuditEntry logs suitable for
 * enterprise security reviews. Implements EU AI Act Article 50 transparency
 * requirements: what the system logged, what data categories were processed,
 * which tools transferred data externally, and any violations detected.
 */

import type { AuditEntry, AuditViolation, DataCategory } from "./audit-types.js";

export type ComplianceReportSummary = {
  /** ISO8601 timestamp when the report was generated */
  generatedAt: string;
  /** Start of the reporting period */
  periodStart: string;
  /** End of the reporting period */
  periodEnd: string;
  /** Total number of audited tool calls in the period */
  totalToolCalls: number;
  /** Number of tool calls that transferred data to external services */
  externalTransfers: number;
  /** Number of tool calls with at least one violation */
  violationCount: number;
  /** Breakdown of violations by type */
  violationsByType: Record<string, number>;
  /** Breakdown of tool calls by tool name */
  toolCallsByTool: Record<string, number>;
  /** All distinct data categories observed in params across the period */
  dataCategories: DataCategory[];
  /** List of tools that performed external transfers */
  externalTransferTools: string[];
  /** All violations with their audit entry references */
  violations: Array<{
    entryId: string;
    timestamp: string;
    toolName: string;
    violations: AuditViolation[];
  }>;
};

/**
 * Generate a compliance report summary from a set of audit entries.
 *
 * Designed for enterprise security teams reviewing AI agent data flows
 * under EU AI Act Article 50.
 */
export function generateComplianceReport(
  entries: AuditEntry[],
  periodStart: Date,
  periodEnd: Date,
): ComplianceReportSummary {
  const toolCallsByTool: Record<string, number> = {};
  const violationsByType: Record<string, number> = {};
  const allCategories = new Set<DataCategory>();
  const externalToolSet = new Set<string>();
  const violationEntries: ComplianceReportSummary["violations"] = [];

  let externalTransfers = 0;
  let violationCount = 0;

  for (const entry of entries) {
    // Tool call count
    toolCallsByTool[entry.toolName] = (toolCallsByTool[entry.toolName] ?? 0) + 1;

    // Data categories
    for (const cat of entry.paramCategories) {
      allCategories.add(cat);
    }
    if (entry.resultCategories) {
      for (const cat of entry.resultCategories) {
        allCategories.add(cat);
      }
    }

    // Violations
    if (entry.violations.length > 0) {
      violationCount++;
      violationEntries.push({
        entryId: entry.id,
        timestamp: entry.timestamp,
        toolName: entry.toolName,
        violations: entry.violations,
      });
      for (const v of entry.violations) {
        violationsByType[v.type] = (violationsByType[v.type] ?? 0) + 1;
      }
    }

    // External transfers: inferred from violations or tool declaration context
    // A tool call counts as an external transfer if it has an
    // external_transfer_without_consent violation or if the tool is known
    // to transfer data externally (detected via unknown_tool flag as conservative).
    const isExternalTransfer = entry.violations.some(
      (v) => v.type === "external_transfer_without_consent" || v.type === "unknown_tool",
    );
    if (isExternalTransfer) {
      externalTransfers++;
      externalToolSet.add(entry.toolName);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    totalToolCalls: entries.length,
    externalTransfers,
    violationCount,
    violationsByType,
    toolCallsByTool,
    dataCategories: [...allCategories],
    externalTransferTools: [...externalToolSet],
    violations: violationEntries,
  };
}

/**
 * Format a ComplianceReportSummary as a human-readable markdown string.
 *
 * Intended for CLI output and enterprise documentation attachments.
 */
export function formatComplianceReport(report: ComplianceReportSummary): string {
  const lines: string[] = [];

  lines.push("# Compliance Report — EU AI Act Article 50");
  lines.push("");
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Period:** ${report.periodStart} — ${report.periodEnd}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tool calls | ${report.totalToolCalls} |`);
  lines.push(`| External transfers | ${report.externalTransfers} |`);
  lines.push(`| Calls with violations | ${report.violationCount} |`);
  lines.push(`| Data categories observed | ${report.dataCategories.length} |`);
  lines.push("");

  if (Object.keys(report.toolCallsByTool).length > 0) {
    lines.push("## Tool Call Breakdown");
    lines.push("");
    lines.push("| Tool | Calls |");
    lines.push("|------|-------|");
    for (const [tool, count] of Object.entries(report.toolCallsByTool)) {
      lines.push(`| ${tool} | ${count} |`);
    }
    lines.push("");
  }

  if (report.dataCategories.length > 0) {
    lines.push("## Data Categories Processed");
    lines.push("");
    for (const cat of report.dataCategories) {
      lines.push(`- ${cat}`);
    }
    lines.push("");
  }

  if (report.externalTransferTools.length > 0) {
    lines.push("## External Transfer Tools");
    lines.push("");
    for (const tool of report.externalTransferTools) {
      lines.push(`- ${tool}`);
    }
    lines.push("");
  }

  if (report.violations.length > 0) {
    lines.push("## Violations");
    lines.push("");
    for (const v of report.violations) {
      lines.push(`### ${v.toolName} — ${v.timestamp}`);
      lines.push(`Entry ID: \`${v.entryId}\``);
      lines.push("");
      for (const viol of v.violations) {
        lines.push(`- **${viol.type}**: ${viol.detail}`);
      }
      lines.push("");
    }
  }

  if (Object.keys(report.violationsByType).length > 0) {
    lines.push("## Violation Summary by Type");
    lines.push("");
    lines.push("| Type | Count |");
    lines.push("|------|-------|");
    for (const [type, count] of Object.entries(report.violationsByType)) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
