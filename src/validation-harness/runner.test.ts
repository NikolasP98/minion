import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTaskType, runValidationHarness } from "./runner.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "runner-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("detectTaskType", () => {
  it("returns explicit taskType from metadata", () => {
    expect(detectTaskType("anything", { taskType: "research" })).toBe("research");
  });

  it("infers code from code blocks", () => {
    expect(detectTaskType("```typescript\nconst x = 1;\n```", {})).toBe("code");
  });

  it("infers research from multiple URLs", () => {
    const content = "See https://a.com and https://b.com also https://c.com for details.";
    expect(detectTaskType(content, {})).toBe("research");
  });

  it("infers data_analysis from statistical terms", () => {
    expect(detectTaskType("p-value = 0.03, confidence interval [1,2]", {})).toBe("data_analysis");
  });

  it("infers writing for long-form text without code or stats", () => {
    const longText = Array.from({ length: 50 }, () => "word").join(" ");
    expect(detectTaskType(longText, {})).toBe("writing");
  });

  it("returns writing as fallback for short ambiguous content", () => {
    expect(detectTaskType("Hello!", {})).toBe("writing");
  });

  it("prefers code detection over research when both have code+URLs", () => {
    const content = "See https://a.com https://b.com https://c.com\n```js\nconsole.log('hi');\n```";
    expect(detectTaskType(content, {})).toBe("code");
  });
});

describe("runValidationHarness", () => {
  it("returns a valid HarnessResult for code content", async () => {
    const result = await runValidationHarness({
      taskId: "run-001",
      agentId: "agent-xyz",
      content: "```typescript\nfunction add(a: number) { return a; }\n```",
      taskType: "code",
      outputDir: tmpDir,
    });
    expect(result.schema_version).toBe("1.0");
    expect(result.task_id).toBe("run-001");
    expect(result.task_type).toBe("code");
    expect(result.assertions.length).toBeGreaterThanOrEqual(8);
    expect(["PASS", "CONDITIONAL_PASS", "FAIL"]).toContain(result.summary.grade);
  });

  it("writes JSON and Markdown artifacts to outputDir", async () => {
    await runValidationHarness({
      taskId: "run-002",
      agentId: "agent-xyz",
      content: "## Intro\nSome text.\n## Conclusion\nEnd.",
      taskType: "writing",
      outputDir: tmpDir,
    });
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.startsWith("validation-harness-"))).toBe(true);
    expect(files.some((f) => f.startsWith("validation-summary-"))).toBe(true);
  });

  it("includes all assertion IDs from registry for research task", async () => {
    const result = await runValidationHarness({
      taskId: "run-003",
      agentId: "agent-xyz",
      content:
        "https://a.com https://b.com https://c.com. Findings. ## Summary section. ## Implications section with more content here.",
      taskType: "research",
      outputDir: tmpDir,
    });
    const ids = result.assertions.map((a) => a.id);
    expect(ids).toContain("research.objective_addressed");
    expect(ids).toContain("research.sources_cited");
    expect(ids).toContain("research.no_hallucinations");
    expect(ids).toContain("research.completeness");
    expect(ids).toContain("research.structured");
    expect(ids).toContain("research.recency");
    expect(ids).toContain("research.sources_accessible");
  });

  it("enforces minimum assertion counts per spec Section 5 — code: 8+", async () => {
    const result = await runValidationHarness({
      taskId: "code-min",
      agentId: "a",
      content: "```js\nconsole.log('hi');\n```",
      taskType: "code",
      outputDir: tmpDir,
    });
    expect(result.assertions.length).toBeGreaterThanOrEqual(8);
  });

  it("enforces minimum assertion counts — research: 6+", async () => {
    const result = await runValidationHarness({
      taskId: "research-min",
      agentId: "a",
      content: "https://a.com https://b.com https://c.com",
      taskType: "research",
      outputDir: tmpDir,
    });
    expect(result.assertions.length).toBeGreaterThanOrEqual(6);
  });

  it("enforces minimum assertion counts — writing: 6+", async () => {
    const result = await runValidationHarness({
      taskId: "writing-min",
      agentId: "a",
      content: "Some writing",
      taskType: "writing",
      outputDir: tmpDir,
    });
    expect(result.assertions.length).toBeGreaterThanOrEqual(6);
  });

  it("enforces minimum assertion counts — data_analysis: 7+", async () => {
    const result = await runValidationHarness({
      taskId: "data-min",
      agentId: "a",
      content: "p-value = 0.05",
      taskType: "data_analysis",
      outputDir: tmpDir,
    });
    expect(result.assertions.length).toBeGreaterThanOrEqual(7);
  });

  it("summary score is between 0 and 1", async () => {
    const result = await runValidationHarness({
      taskId: "score-check",
      agentId: "a",
      content: "```python\nprint('hello')\n```",
      taskType: "code",
      outputDir: tmpDir,
    });
    expect(result.summary.score).toBeGreaterThanOrEqual(0);
    expect(result.summary.score).toBeLessThanOrEqual(1);
  });
});
