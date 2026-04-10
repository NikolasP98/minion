import { writeArtifacts } from "./artifacts.js";
import { evaluateCodeAssertions } from "./assertions/code.js";
import { evaluateDataAnalysisAssertions } from "./assertions/data-analysis.js";
import { evaluateResearchAssertions } from "./assertions/research.js";
import { evaluateWritingAssertions } from "./assertions/writing.js";
import { buildSummary } from "./scoring.js";
import type { AssertionContext, HarnessResult, TaskType } from "./types.js";

const CODE_BLOCK_RE = /```[\w]*\n[\s\S]+?```/;
const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
const STATS_RE = /\b(p-value|confidence interval|ci:|standard deviation|regression)\b/i;

/**
 * Infer the task type from output content and metadata.
 * Explicit `taskType` in metadata always wins.
 */
export function detectTaskType(content: string, taskMetadata: Record<string, unknown>): TaskType {
  if (
    typeof taskMetadata.taskType === "string" &&
    ["code", "research", "writing", "data_analysis"].includes(taskMetadata.taskType)
  ) {
    return taskMetadata.taskType as TaskType;
  }

  if (CODE_BLOCK_RE.test(content)) {
    return "code";
  }
  if (STATS_RE.test(content)) {
    return "data_analysis";
  }
  URL_RE.lastIndex = 0;
  const urlCount = (content.match(URL_RE) ?? []).length;
  if (urlCount >= 3) {
    return "research";
  }
  return "writing";
}

export interface RunHarnessOptions {
  taskId: string;
  agentId: string;
  content: string;
  taskType?: TaskType;
  taskMetadata?: Record<string, unknown>;
  outputDir: string;
}

/**
 * Run the full validation harness for a completed task.
 * Evaluates assertions, scores the result, writes artifacts, and returns the full result.
 */
export async function runValidationHarness(opts: RunHarnessOptions): Promise<HarnessResult> {
  const { taskId, agentId, content, outputDir, taskMetadata = {} } = opts;

  const taskType = opts.taskType ?? detectTaskType(content, taskMetadata);
  const assertionCtx: AssertionContext = { content, taskMetadata };

  const assertions = ((): ReturnType<typeof evaluateCodeAssertions> => {
    switch (taskType) {
      case "code":
        return evaluateCodeAssertions(assertionCtx);
      case "research":
        return evaluateResearchAssertions(assertionCtx);
      case "writing":
        return evaluateWritingAssertions(assertionCtx);
      case "data_analysis":
        return evaluateDataAnalysisAssertions(assertionCtx);
    }
  })();

  const summary = buildSummary(assertions);

  const result: HarnessResult = {
    schema_version: "1.0",
    task_id: taskId,
    task_type: taskType,
    generated_at: new Date().toISOString(),
    agent_id: agentId,
    summary,
    assertions,
  };

  await writeArtifacts(result, outputDir);

  return result;
}
