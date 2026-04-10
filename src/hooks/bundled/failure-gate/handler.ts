/**
 * Failure Gate Hook Handler
 *
 * Hard-blocks `done` status transitions when the latest validation harness
 * grade is FAIL. Per QA Spec MIN-170 Section 6.3.
 *
 * Fires on agent:task_completing events. When the gate blocks, it sets
 * `context.blocked = true` and `context.blockReason` on the event, and
 * pushes an error message for the agent.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { checkFailureGate } from "../../../validation-harness/failure-gate.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/failure-gate");

export interface FailureGateHookContext extends Record<string, unknown> {
  taskId: string;
  targetStatus: string;
  validationDir: string;
  blocked?: boolean;
  blockReason?: string;
  warnings?: string[];
}

function isFailureGateContext(ctx: Record<string, unknown>): ctx is FailureGateHookContext {
  return (
    typeof ctx.taskId === "string" &&
    typeof ctx.targetStatus === "string" &&
    typeof ctx.validationDir === "string"
  );
}

const failureGateHandler: HookHandler = async (event) => {
  if (event.type !== "agent" || event.action !== "task_completing") {
    return;
  }

  const context = event.context;
  if (!isFailureGateContext(context)) {
    return;
  }

  // Only gate `done` transitions
  if (context.targetStatus !== "done") {
    return;
  }

  try {
    const result = await checkFailureGate({
      validationDir: context.validationDir,
      taskId: context.taskId,
    });

    if (!result.allowed) {
      context.blocked = true;
      context.blockReason = result.reason;
      event.messages.push(
        `**Failure Gate: transition to \`done\` blocked.**\n\n` +
          `${result.reason}\n\n` +
          `Failed assertions: ${result.failedAssertionIds.join(", ")}`,
      );
      log.warn("Failure gate blocked done transition", {
        taskId: context.taskId,
        failedAssertionIds: result.failedAssertionIds,
      });
      return;
    }

    if (result.grade === "CONDITIONAL_PASS" && result.warnings.length > 0) {
      context.warnings = result.warnings;
      event.messages.push(
        `**Failure Gate: CONDITIONAL_PASS** — marking done with warnings:\n` +
          result.warnings.map((w) => `- ${w}`).join("\n"),
      );
      log.info("Failure gate allowed with warnings", {
        taskId: context.taskId,
        grade: result.grade,
        warningCount: result.warnings.length,
      });
    }
  } catch (err) {
    log.error("Failure gate check failed", { taskId: context.taskId, error: String(err) });
    // On error, allow the transition (fail-open to avoid blocking work)
  }
};

export default failureGateHandler;
