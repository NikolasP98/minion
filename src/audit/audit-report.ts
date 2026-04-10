/**
 * AudAgent C: Compliance report generator for EU AI Act Article 50.
 *
 * Reads JSONL audit logs produced by AuditStore (Phase B) and generates
 * a structured transparency report satisfying Article 50 requirements.
 *
 * Reference: arXiv:2511.07441 — AudAgent compliance report format
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEntry, AuditViolation, DataCategory } from "./audit-types.js";
import { AuditStore } from "./audit-store.js";

export type ReportFormat = "json" | "markdown" | "html";

export type ReportOptions = {
  /** Start of audit window. Default: 30 days ago. */
  start?: Date;
  /** End of audit window. Default: now. */
  end?: Date;
  /** Output format. Default: "json". */
  format?: ReportFormat;
  /** Audit log directory. Default: ~/.minion/audit/ */
  auditDir?: string;
  /** Version of the Minion privacy policy in effect. */
  policyVersion?: string;
};

export type DataFlowSummary = {
  tool: string;
  vendor: string;
  dataCategories: DataCategory[];
  consentScope: string;
  invocationCount: number;
  thirdParty: boolean;
  violationCount: number;
};

export type ComplianceReport = {
  /** ISO8601 timestamp when this report was generated */
  reportDate: string;
  period: { start: string; end: string };
  totalToolInvocations: number;
  totalViolations: number;
  dataFlows: DataFlowSummary[];
  violations: AuditViolation[];
  /** sha256 hash of the concatenated audit log content covering the period */
  auditLogHash: string;
  policyVersion: string;
};

/**
 * Generate a compliance report from audit log entries in the given window.
 *
 * Aggregate per-tool data flows, collect all violations, and compute a
 * tamper-evident hash over the raw JSONL content for the report period.
 */
export async function generateComplianceReport(opts: ReportOptions = {}): Promise<ComplianceReport> {
  const end = opts.end ?? new Date();
  const start = opts.start ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const auditDir = opts.auditDir ?? path.join(os.homedir(), ".minion", "audit");
  const policyVersion = opts.policyVersion ?? "1.0.0";

  const store = new AuditStore({ dir: auditDir, enabled: true });
  const entries = await store.readRange(start, end);

  const auditLogHash = await computeAuditLogHash(auditDir, start, end);

  const flowMap = new Map<string, DataFlowSummary>();
  const allViolations: AuditViolation[] = [];

  for (const entry of entries) {
    allViolations.push(...entry.violations);

    const existing = flowMap.get(entry.toolName);
    if (existing) {
      mergeDataCategories(existing.dataCategories, entry.paramCategories);
      if (entry.resultCategories) {
        mergeDataCategories(existing.dataCategories, entry.resultCategories);
      }
      existing.invocationCount++;
      existing.violationCount += entry.violations.length;
    } else {
      const decl = lookupToolDeclaration(entry);
      const categories = [...entry.paramCategories];
      if (entry.resultCategories) {
        mergeDataCategories(categories, entry.resultCategories);
      }
      flowMap.set(entry.toolName, {
        tool: entry.toolName,
        vendor: decl.vendor,
        dataCategories: categories,
        consentScope: entry.consentScope,
        invocationCount: 1,
        thirdParty: decl.externalTransfer,
        violationCount: entry.violations.length,
      });
    }
  }

  return {
    reportDate: new Date().toISOString(),
    period: { start: start.toISOString(), end: end.toISOString() },
    totalToolInvocations: entries.length,
    totalViolations: allViolations.length,
    dataFlows: Array.from(flowMap.values()).sort((a, b) => b.invocationCount - a.invocationCount),
    violations: allViolations,
    auditLogHash,
    policyVersion,
  };
}

function mergeDataCategories(target: DataCategory[], incoming: DataCategory[]): void {
  for (const cat of incoming) {
    if (!target.includes(cat)) {
      target.push(cat);
    }
  }
}

function lookupToolDeclaration(entry: AuditEntry): {
  vendor: string;
  externalTransfer: boolean;
} {
  // Best-effort from audit entry fields; the tool-privacy-policy module has
  // the canonical declarations but we don't want to re-classify here —
  // we trust what was recorded at tool-call time.
  const name = entry.toolName.toLowerCase();
  const isExternal =
    name.includes("web_search") ||
    name.includes("http") ||
    name.includes("fetch") ||
    name.includes("email") ||
    name.includes("send");

  return {
    vendor: isExternal ? "third-party" : "local",
    externalTransfer: isExternal,
  };
}

/**
 * Compute a SHA-256 hash over all raw JSONL content for audit files covering
 * the [from, to] date range. Files that do not exist are skipped.
 *
 * The hash provides a tamper-evident fingerprint for the report period.
 */
async function computeAuditLogHash(dir: string, from: Date, to: Date): Promise<string> {
  const hash = crypto.createHash("sha256");

  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const endDay = new Date(to);
  endDay.setHours(23, 59, 59, 999);

  while (cursor <= endDay) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const filePath = path.join(dir, `audit-${dateStr}.jsonl`);
    try {
      const content = await fs.promises.readFile(filePath);
      hash.update(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return `sha256:${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatReportAsMarkdown(report: ComplianceReport): string {
  const lines: string[] = [];
  lines.push("# EU AI Act Article 50 — Transparency Report");
  lines.push("");
  lines.push(`**Generated:** ${report.reportDate}`);
  lines.push(`**Period:** ${report.period.start} → ${report.period.end}`);
  lines.push(`**Policy version:** ${report.policyVersion}`);
  lines.push(`**Audit log hash:** \`${report.auditLogHash}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tool invocations | ${report.totalToolInvocations} |`);
  lines.push(`| Total violations | ${report.totalViolations} |`);
  lines.push(`| Distinct tools | ${report.dataFlows.length} |`);
  lines.push("");
  lines.push("## Data Flows");
  lines.push("");
  lines.push("| Tool | Vendor | Data Categories | Consent Scope | Invocations | Third-Party | Violations |");
  lines.push("|------|--------|----------------|---------------|------------|-------------|-----------|");
  for (const flow of report.dataFlows) {
    const cats = flow.dataCategories.join(", ") || "none";
    lines.push(
      `| ${flow.tool} | ${flow.vendor} | ${cats} | ${flow.consentScope} | ${flow.invocationCount} | ${flow.thirdParty ? "yes" : "no"} | ${flow.violationCount} |`,
    );
  }
  lines.push("");
  if (report.violations.length > 0) {
    lines.push("## Violations");
    lines.push("");
    for (const v of report.violations) {
      lines.push(`- **${v.type}**: ${v.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function formatReportAsHtml(report: ComplianceReport): string {
  const md = formatReportAsMarkdown(report);
  // Minimal HTML wrapper — no external deps
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EU AI Act Article 50 — Transparency Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f5f5f5; }
    code { background: #f0f0f0; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
    h1, h2 { border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
  </style>
</head>
<body>
<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatReport(report: ComplianceReport, format: ReportFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);
    case "markdown":
      return formatReportAsMarkdown(report);
    case "html":
      return formatReportAsHtml(report);
  }
}
