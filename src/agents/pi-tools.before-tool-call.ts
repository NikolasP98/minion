import type { MinionConfig } from "../config/config.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { checkCommandAutonomy } from "../security/autonomy-enforcement.js";
import { isPlainObject } from "../utils.js";
import type { ApprovalContext } from "./approval-gate.js";
import { applyApprovalGate, classifyToolCategory } from "./approval-gate.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { checkForObfuscation, extractCommandFromParams } from "./tools/obfuscated-command-guard.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  loopDetection?: ToolLoopDetectionConfig;
  /** Config for autonomy enforcement checks on exec/shell tools. */
  config?: MinionConfig;
  /** Optional context for the human-in-the-loop approval gate (Sprint E.1). */
  approvalContext?: ApprovalContext;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { recordToolCallOutcome } = await import("./tool-loop-detection.js");
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

/**
 * Detect tool calls that appear to be truncated from a cut-off LLM stream.
 *
 * Two signals are checked:
 * 1. The raw tool name is empty/blank — the stream stopped before emitting a name.
 * 2. The raw params value is a non-empty string that is not valid JSON — the stream
 *    delivered a partial JSON fragment that the SDK forwarded without completing it.
 *
 * Returns a human-readable reason string when truncation is detected, `null` otherwise.
 */
export function detectTruncatedToolCall(rawName: string, params: unknown): string | null {
  if (!rawName || !rawName.trim()) {
    return "Tool call has an empty function name — stream was likely truncated before the name was emitted";
  }
  if (typeof params === "string" && params.length > 0) {
    try {
      JSON.parse(params);
    } catch {
      return `Tool call arguments are a partial JSON string (likely truncated stream): ${params.slice(0, 120)}`;
    }
  }
  return null;
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  // ── Truncation guard ────────────────────────────────────────────────────────
  // Detect and block tool calls that appear to originate from a truncated stream
  // before any other logic runs. Executing a tool with partial arguments can
  // produce incorrect or dangerous results (mirrors Hermes commit 2d0d05a3).
  const truncationReason = detectTruncatedToolCall(args.toolName, args.params);
  if (truncationReason) {
    log.warn(`[truncation-guard] Blocking ${args.toolName || "(empty)"}: ${truncationReason}`);
    return { blocked: true, reason: truncationReason };
  }

  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { logToolLoopAction } = await import("../logging/diagnostic.js");
    const { detectToolCallLoop, recordToolCall } = await import("./tool-loop-detection.js");

    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  // ── Autonomy enforcement ────────────────────────────────────────────────
  // Check exec/shell tools against the configured autonomy mode (full/supervised/readonly).
  const autonomyResult = checkCommandAutonomy({
    toolName,
    toolParams: params,
    config: args.ctx?.config,
  });
  if (autonomyResult?.blocked) {
    log.warn(`[autonomy] Blocked ${toolName}: ${autonomyResult.reason}`);
    return { blocked: true, reason: autonomyResult.reason };
  }

  // ── Obfuscated command guard ────────────────────────────────────────────
  // EE.1: Detect obfuscated shell commands before reaching the approval gate.
  // When detected, block and require explicit user re-approval even in auto mode.
  if (classifyToolCategory(toolName) === "shell") {
    const command = extractCommandFromParams(args.params);
    if (command) {
      const obfuscationResult = checkForObfuscation(command);
      if (obfuscationResult.obfuscated) {
        log.warn(
          `[obfuscation-guard] Blocked ${toolName}: command matches obfuscation pattern #${obfuscationResult.matchedPatternIndex}`,
        );
        return {
          blocked: true,
          reason:
            "Command contains obfuscation patterns (base64-encoded payload, eval with dynamic code, or similar). " +
            "Please review and run the decoded command directly if it is safe.",
        };
      }
    }
  }

  // ── Approval gate ───────────────────────────────────────────────────────
  // Human-in-the-loop gate: confirm / admin-only modes per tool category.
  const gateConfig = args.ctx?.config?.approvals?.gate;
  if (gateConfig) {
    const gateResult = await applyApprovalGate(
      toolName,
      gateConfig,
      args.ctx?.approvalContext ?? {},
    );
    if (!gateResult.allowed) {
      log.warn(`[approval-gate] Blocked ${toolName}: ${gateResult.reason}`);
      return { blocked: true, reason: gateResult.reason };
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
  detectTruncatedToolCall,
};
