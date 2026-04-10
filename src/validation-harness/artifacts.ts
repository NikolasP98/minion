import fs from "node:fs/promises";
import path from "node:path";
import type { AssertionStatus, HarnessResult } from "./types.js";

const STATUS_LABEL: Record<AssertionStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
};

/**
 * Format a HarnessResult as the Markdown comment body per spec Section 6.2.
 */
export function formatMarkdownSummary(result: HarnessResult): string {
  const { summary, assertions } = result;
  const nonSkipped = summary.total - summary.skipped;
  const pct = Math.round(summary.score * 100);
  const gradeLabel = `**Output Quality: ${summary.passed}/${nonSkipped} checks passed (${pct}%) — ${summary.grade}**`;

  const rows = assertions.map((a, i) => {
    const statusCell =
      a.status === "fail" && a.detail ? `FAIL — ${a.detail}` : STATUS_LABEL[a.status];
    return `| ${i + 1} | ${a.name} | ${statusCell} |`;
  });

  return [
    "## Validation Harness Result",
    "",
    gradeLabel,
    "",
    "| # | Check | Status |",
    "|---|-------|--------|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Write JSON and Markdown artifacts to the given directory.
 * Returns the paths of both written files.
 */
export async function writeArtifacts(
  result: HarnessResult,
  outputDir: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  await fs.mkdir(outputDir, { recursive: true });

  const safeId = result.task_id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const jsonPath = path.join(outputDir, `validation-harness-${safeId}.json`);
  const mdPath = path.join(outputDir, `validation-summary-${safeId}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  await fs.writeFile(mdPath, formatMarkdownSummary(result), "utf-8");

  return { jsonPath, mdPath };
}
