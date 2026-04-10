/**
 * OutcomeDetector — LLM-as-judge service (MIN-308)
 *
 * Evaluates agent task transcripts against configured outcome definitions
 * and routes by confidence:
 *   ≥ confidenceThreshold (default 0.85) → bill (success or partial only)
 *   0.60 – <threshold                   → human review queue
 *   < 0.60                              → auto-decline
 *
 * Every detection writes an audit log entry regardless of outcome (1-year retention).
 *
 * BillingEventEmitter integration (MIN-347):
 * After a confident detection with outcome=success|partial, emitOutcomeEvent()
 * is called fire-and-forget — the detector never awaits it.
 */

import type {
  BillingEventEmitter,
  OutcomeDefinition,
  OutcomeDetectionResult,
} from "../billing/billing-event-emitter.js";
import type { SubsystemLogger } from "../logging/subsystem.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeResult = "success" | "failure" | "partial" | "inconclusive";

export interface CriterionResult {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface DetectionResult {
  outcome: OutcomeResult;
  confidence: number;
  reasoning: string; // customer-visible
  criteriaEvaluation: CriterionResult[];
  billingAmount: number | undefined; // cents; undefined if not billable
}

export interface TaskMetadata {
  agentName: string;
  taskType: string;
  completedAt: string; // ISO-8601
  customerId: string;
}

/**
 * Minimal LLM client interface — decoupled from any provider SDK.
 * In production, implement with the Minion provider client.
 */
export interface LLMClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: { type: "json_object" };
        max_tokens: number;
      }): Promise<{ choices: Array<{ message: { content: string } }> }>;
    };
  };
}

/**
 * Minimal audit log interface.
 * Implement against whatever persistence layer is configured for 1-year retention.
 */
export interface OutcomeAuditLog {
  record(entry: {
    taskId: string;
    agentId: string;
    definition: OutcomeDefinition;
    outcome: OutcomeResult;
    confidence: number;
    reasoning: string;
    criteriaEvaluation: CriterionResult[];
    llmModel: string;
    detectedAt: Date;
    billingAmount: number | undefined;
  }): Promise<void>;
}

/**
 * Human review queue interface — entries are manually resolved via admin UI.
 */
export interface HumanReviewQueue {
  enqueue(entry: {
    taskId: string;
    agentId: string;
    definition: OutcomeDefinition;
    result: DetectionResult;
    detectedAt: Date;
  }): Promise<void>;
}

// ── LLM judge prompts ─────────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are a billing accuracy evaluator for an AI agent platform.
Your job is to assess whether an agent interaction achieved a defined outcome based on its transcript.
Be conservative — only judge SUCCESS when the evidence clearly meets the criteria.
Respond in JSON only.`;

function buildJudgePrompt(
  transcript: string,
  definition: FullOutcomeDefinition,
  metadata: TaskMetadata,
): string {
  const criteria = definition.successCriteria
    .map((c, i) => `${i + 1}. [${c.required ? "REQUIRED" : "OPTIONAL"}] ${c.condition}`)
    .join("\n");

  return `## Task Context
Agent: ${metadata.agentName}
Task type: ${metadata.taskType}
Completed at: ${metadata.completedAt}

## Outcome Definition
Name: ${definition.name}
Description: ${definition.description}

## Success Criteria
${criteria}

## Agent Interaction Transcript
${transcript}

## Your Assessment
Evaluate each success criterion against the transcript. Then provide your overall judgment.

Respond with this JSON structure:
{
  "outcome": "success" | "failure" | "partial" | "inconclusive",
  "confidence": 0.0 to 1.0,
  "reasoning": "one paragraph explanation (customer-visible)",
  "criteriaEvaluation": [
    { "criterion": "...", "met": true/false, "evidence": "quote from transcript" }
  ]
}`;
}

// ── OutcomeDefinition (extended for the LLM judge) ────────────────────────────

export interface SuccessCriterion {
  condition: string;
  required: boolean;
}

// Augment OutcomeDefinition from billing module with fields needed by the judge
export interface FullOutcomeDefinition extends OutcomeDefinition {
  name: string;
  description: string;
  successCriteria: SuccessCriterion[];
}

// ── OutcomeDetector ───────────────────────────────────────────────────────────

export class OutcomeDetector {
  constructor(
    private readonly llm: LLMClient,
    private readonly auditLog: OutcomeAuditLog,
    private readonly billingEventEmitter: BillingEventEmitter,
    private readonly humanReviewQueue: HumanReviewQueue,
    private readonly logger: SubsystemLogger,
  ) {}

  /**
   * Evaluates a completed task transcript against the given outcome definition.
   * Does NOT block agent execution — must be called fire-and-forget from the queue.
   */
  async evaluate(
    taskId: string,
    agentId: string,
    transcript: string,
    definition: FullOutcomeDefinition,
    metadata: TaskMetadata,
  ): Promise<DetectionResult> {
    const detectedAt = new Date();

    // ── Call LLM judge ────────────────────────────────────────────────────────
    let rawResult: {
      outcome: OutcomeResult;
      confidence: number;
      reasoning: string;
      criteriaEvaluation: CriterionResult[];
    };

    try {
      const response = await this.llm.chat.completions.create({
        model: "claude-haiku-4-5",
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: buildJudgePrompt(transcript, definition, metadata) },
        ],
        response_format: { type: "json_object" },
        max_tokens: 512,
      });

      rawResult = JSON.parse(response.choices[0].message.content) as typeof rawResult;
    } catch (err) {
      // LLM failure → inconclusive; never crash silently
      this.logger.error("OutcomeDetector: LLM judge call failed", {
        err: err instanceof Error ? err.message : String(err),
        taskId,
        definitionId: definition.id,
      });
      rawResult = {
        outcome: "inconclusive",
        confidence: 0,
        reasoning: "Detection failed due to internal error.",
        criteriaEvaluation: [],
      };
    }

    const result: DetectionResult = {
      ...rawResult,
      billingAmount: this.calculateBillingAmount(rawResult.outcome, definition),
    };

    // ── Route by confidence ───────────────────────────────────────────────────
    if (result.confidence >= definition.confidenceThreshold) {
      if (result.outcome === "success" || result.outcome === "partial") {
        // MIN-347: fire-and-forget billing emit — must NOT await
        const detectionForBilling: OutcomeDetectionResult = {
          taskId,
          agentId,
          customerId: metadata.customerId,
          outcome: result.outcome,
          confidence: result.confidence,
          detectedAt,
        };

        this.billingEventEmitter
          .emitOutcomeEvent(detectionForBilling, definition)
          .catch((err: unknown) => {
            this.logger.error("Billing emit error (fire-and-forget)", {
              err: err instanceof Error ? err.message : String(err),
              taskId,
            });
          });
      }
    } else if (result.confidence >= 0.6) {
      await this.humanReviewQueue.enqueue({
        taskId,
        agentId,
        definition,
        result,
        detectedAt,
      });
    }
    // else: auto-decline, no billing, no review

    // ── Audit log (every detection, 1-year retention) ─────────────────────────
    await this.auditLog.record({
      taskId,
      agentId,
      definition,
      outcome: result.outcome,
      confidence: result.confidence,
      reasoning: result.reasoning,
      criteriaEvaluation: result.criteriaEvaluation,
      llmModel: "claude-haiku-4-5",
      detectedAt,
      billingAmount: result.billingAmount,
    });

    return result;
  }

  private calculateBillingAmount(
    outcome: OutcomeResult,
    definition: OutcomeDefinition,
  ): number | undefined {
    if (outcome === "success") {
      return definition.pricePerOutcome;
    }
    if (outcome === "partial") {
      return Math.round(definition.pricePerOutcome * definition.partialBillingRate);
    }
    return undefined;
  }
}
