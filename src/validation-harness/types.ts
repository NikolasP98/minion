export type TaskType = "code" | "research" | "writing" | "data_analysis";

export type AssertionStatus = "pass" | "fail" | "skip";

export type Grade = "PASS" | "CONDITIONAL_PASS" | "FAIL";

export interface AssertionResult {
  id: string;
  category: string;
  name: string;
  description: string;
  required: boolean;
  status: AssertionStatus;
  detail: string;
  weight: number;
}

export interface HarnessSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  score: number;
  grade: Grade;
  label: string;
}

export interface HarnessResult {
  schema_version: "1.0";
  task_id: string;
  task_type: TaskType;
  generated_at: string;
  agent_id: string;
  summary: HarnessSummary;
  assertions: AssertionResult[];
}

/** Context passed to assertion evaluators */
export interface AssertionContext {
  /** The full text content of the agent's response */
  content: string;
  /** Optional task metadata from hook context */
  taskMetadata?: Record<string, unknown>;
}
