import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMarkdownSummary, writeArtifacts } from "./artifacts.js";
import type { HarnessResult } from "./types.js";

const SAMPLE_RESULT: HarnessResult = {
  schema_version: "1.0",
  task_id: "test-task-123",
  task_type: "code",
  generated_at: "2026-04-10T10:00:00.000Z",
  agent_id: "agent-abc",
  summary: {
    total: 3,
    passed: 2,
    failed: 1,
    skipped: 0,
    score: 0.857,
    grade: "PASS",
    label: "Output Quality: 2/3 checks passed (87%)",
  },
  assertions: [
    {
      id: "code.syntax",
      category: "code",
      name: "Syntax Valid",
      description: "Output parses without errors",
      required: true,
      status: "pass",
      detail: "Code blocks present",
      weight: 1.0,
    },
    {
      id: "code.no_secrets",
      category: "code",
      name: "No Hardcoded Secrets",
      description: "No secrets in output",
      required: true,
      status: "pass",
      detail: "No secrets detected",
      weight: 1.0,
    },
    {
      id: "code.lint",
      category: "code",
      name: "Lint Clean",
      description: "No lint errors",
      required: false,
      status: "fail",
      detail: "Lint not available",
      weight: 0.5,
    },
  ],
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "validation-harness-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("formatMarkdownSummary", () => {
  it("starts with ## Validation Harness Result heading", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md.trim()).toMatch(/^## Validation Harness Result/);
  });

  it("includes the grade and label line", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md).toContain("PASS");
    expect(md).toContain("2/3 checks passed");
  });

  it("includes a table row for each assertion", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md).toContain("Syntax Valid");
    expect(md).toContain("No Hardcoded Secrets");
    expect(md).toContain("Lint Clean");
  });

  it("shows PASS for passing assertions", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md).toContain("| 1 | Syntax Valid | PASS |");
  });

  it("shows FAIL with detail for failing assertions", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md).toContain("FAIL — Lint not available");
  });

  it("marks skipped assertions as SKIP", () => {
    const resultWithSkip: HarnessResult = {
      ...SAMPLE_RESULT,
      assertions: [
        ...SAMPLE_RESULT.assertions,
        {
          id: "code.type_check",
          category: "code",
          name: "Type Check Passes",
          description: "Static type analysis",
          required: false,
          status: "skip",
          detail: "Skipped: untyped",
          weight: 0.5,
        },
      ],
    };
    const md = formatMarkdownSummary(resultWithSkip);
    expect(md).toContain("SKIP");
  });
});

describe("writeArtifacts", () => {
  it("writes JSON artifact to correct filename", async () => {
    const { jsonPath } = await writeArtifacts(SAMPLE_RESULT, tmpDir);
    expect(path.basename(jsonPath)).toBe("validation-harness-test-task-123.json");
    const raw = await fs.readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as HarnessResult;
    expect(parsed.task_id).toBe("test-task-123");
    expect(parsed.schema_version).toBe("1.0");
  });

  it("writes Markdown artifact to correct filename", async () => {
    const { mdPath } = await writeArtifacts(SAMPLE_RESULT, tmpDir);
    expect(path.basename(mdPath)).toBe("validation-summary-test-task-123.md");
    const content = await fs.readFile(mdPath, "utf-8");
    expect(content).toContain("Validation Harness Result");
  });

  it("creates parent directory if it does not exist", async () => {
    const subDir = path.join(tmpDir, "new-subdir", "validation");
    const { jsonPath } = await writeArtifacts(SAMPLE_RESULT, subDir);
    const exists = await fs
      .access(jsonPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("sanitizes special characters in task_id for filename", async () => {
    const resultWithSpecialId: HarnessResult = {
      ...SAMPLE_RESULT,
      task_id: "agent:main:main-1234567890",
    };
    const { jsonPath } = await writeArtifacts(resultWithSpecialId, tmpDir);
    expect(path.basename(jsonPath)).not.toContain(":");
    expect(path.basename(jsonPath)).toMatch(/^validation-harness-.+\.json$/);
  });
});
