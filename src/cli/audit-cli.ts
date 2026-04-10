/**
 * `minion audit` — EU AI Act Article 50 compliance CLI.
 *
 * Generates transparency reports from the AudAgent JSONL audit log.
 */

import type { Command } from "commander";
import { generateComplianceReport, formatReport } from "../audit/audit-report.js";
import type { ReportFormat } from "../audit/audit-report.js";
import { defaultRuntime } from "../runtime.js";
import { formatHelpExamples } from "./help-format.js";
import { theme } from "../terminal/theme.js";

type AuditReportOptions = {
  start?: string;
  end?: string;
  format?: ReportFormat;
  dir?: string;
  policyVersion?: string;
};

function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) {
    return fallback;
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${raw}`);
  }
  return d;
}

export function registerAuditCli(program: Command) {
  const audit = program
    .command("audit")
    .description("EU AI Act Article 50 compliance tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["minion audit report", "Generate a compliance report for the last 30 days (JSON)."],
          ["minion audit report --format markdown", "Output as Markdown."],
          ["minion audit report --format html --start 2026-01-01", "HTML report from Jan 1."],
          ["minion audit report --start 2026-03-01 --end 2026-03-31", "March 2026 window."],
        ])}\n`,
    );

  audit
    .command("report")
    .description("Generate a compliance transparency report (EU AI Act Article 50)")
    .option("--start <date>", "Start of audit window (ISO8601 date or datetime)")
    .option("--end <date>", "End of audit window (ISO8601 date or datetime, default: now)")
    .option(
      "--format <format>",
      "Output format: json | markdown | html (default: json)",
      "json",
    )
    .option("--dir <path>", "Audit log directory (default: ~/.minion/audit)")
    .option("--policy-version <version>", "Privacy policy version string (default: 1.0.0)")
    .action(async (opts: AuditReportOptions) => {
      const now = new Date();
      const end = parseDate(opts.end, now);
      const start = parseDate(opts.start, new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000));
      const format = (opts.format ?? "json") as ReportFormat;

      if (!["json", "markdown", "html"].includes(format)) {
        defaultRuntime.log(`Error: --format must be one of: json, markdown, html`);
        process.exitCode = 1;
        return;
      }

      const report = await generateComplianceReport({
        start,
        end,
        format,
        auditDir: opts.dir,
        policyVersion: opts.policyVersion,
      });

      defaultRuntime.log(formatReport(report, format));
    });
}
