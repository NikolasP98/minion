/**
 * AuditPlugin — before_tool_call / after_tool_call hooks for AudAgent.
 *
 * Implements EU AI Act Article 50 data-flow governance:
 * - Intercepts every tool call to classify data categories
 * - Detects policy violations (undeclared categories, external transfer)
 * - Optionally blocks calls that would violate consent (complianceGate)
 * - Appends a structured AuditEntry to the AuditStore after each call
 *
 * Fire-and-forget on the after hook: audit I/O never delays tool execution.
 */

import crypto from "node:crypto";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookRegistration,
  PluginHookToolContext,
} from "../plugins/types.js";
import type { AuditStore } from "./audit-store.js";
import type { AuditEntry, AuditViolation, ConsentScope, DataCategory } from "./audit-types.js";
import { classifyParams } from "./data-classifier.js";
import { getToolPrivacyDeclaration } from "./tool-privacy-policy.js";

export type AuditPluginOptions = {
  store: AuditStore;
  /** Block tool calls with consent violations when true. Default: false. */
  complianceGate?: boolean;
};

// ---------------------------------------------------------------------------
// Pending call correlation types
//
// before_tool_call runs sequentially; after_tool_call fires after completion.
// We correlate them via a FIFO queue keyed by "<sessionKey>:<agentId>:<toolName>".
// The map is a closure inside createAuditPlugin so each plugin instance is isolated.
// ---------------------------------------------------------------------------

type PendingCallRecord = {
  callId: string;
  startedAt: number;
  paramCategories: DataCategory[];
  declaration: ReturnType<typeof getToolPrivacyDeclaration>;
  violations: AuditViolation[];
  consentScope: ConsentScope;
};

function pendingKey(ctx: PluginHookToolContext): string {
  return `${ctx.sessionKey ?? ""}:${ctx.agentId ?? ""}:${ctx.toolName}`;
}

// ---------------------------------------------------------------------------
// Violation detection
// ---------------------------------------------------------------------------

function detectViolations(
  paramCategories: DataCategory[],
  declaration: ReturnType<typeof getToolPrivacyDeclaration>,
  consentScope: ConsentScope,
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  const declared = new Set<DataCategory>(declaration.dataCategories);

  // Unknown tool — conservative flag
  if (declaration.vendor === "unknown") {
    violations.push({
      type: "unknown_tool",
      detail: `Tool "${declaration.toolName}" has no privacy declaration; data handling is unknown.`,
    });
  }

  // Undeclared data categories
  const undeclared = paramCategories.filter((cat) => !declared.has(cat));
  if (undeclared.length > 0) {
    violations.push({
      type: "undeclared_data_category",
      detail: `Categories not declared in tool privacy policy: ${undeclared.join(", ")}`,
    });
  }

  // External transfer without explicit/implicit consent for sensitive categories
  const sensitiveCategories: DataCategory[] = new Set([
    "credentials",
    "user_identity",
    "user_location",
  ]);
  const hasSensitiveData = paramCategories.some((cat) => sensitiveCategories.has(cat));

  if (declaration.externalTransfer && hasSensitiveData && consentScope === "none") {
    violations.push({
      type: "external_transfer_without_consent",
      detail: `Tool "${declaration.toolName}" transfers sensitive data externally without user consent.`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Consent scope resolution
//
// Simplified heuristic: default to "implicit" (user consents by using the service).
// The full consent management system is a separate feature.
// ---------------------------------------------------------------------------

function resolveConsentScope(
  _declaration: ReturnType<typeof getToolPrivacyDeclaration>,
): ConsentScope {
  return "implicit";
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Create before_tool_call and after_tool_call hook registrations.
 *
 * These are wired into the plugin registry by builtin-plugins.ts when
 * cfg.audit?.enabled === true.
 */
export function createAuditPlugin(opts: AuditPluginOptions): PluginHookRegistration[] {
  const { store, complianceGate = false } = opts;
  const PLUGIN_ID = "audit";
  const SOURCE = "builtin";

  // Per-instance correlation map: not module-level so tests and multiple
  // plugin instances remain isolated.
  const pendingCalls = new Map<string, PendingCallRecord[]>();

  const beforeHandler = (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): PluginHookBeforeToolCallResult | void => {
    const declaration = getToolPrivacyDeclaration(event.toolName);
    const paramCategories = classifyParams(event.params);
    const consentScope = resolveConsentScope(declaration);
    const violations = detectViolations(paramCategories, declaration, consentScope);

    const record: PendingCallRecord = {
      callId: crypto.randomUUID(),
      startedAt: Date.now(),
      paramCategories,
      declaration,
      violations,
      consentScope,
    };

    const key = pendingKey(ctx);
    let queue = pendingCalls.get(key);
    if (!queue) {
      queue = [];
      pendingCalls.set(key, queue);
    }
    queue.push(record);

    // complianceGate: block calls with consent violations
    if (complianceGate && violations.length > 0) {
      const blockable = violations.filter(
        (v) =>
          v.type === "external_transfer_without_consent" || v.type === "undeclared_data_category",
      );
      if (blockable.length > 0) {
        return {
          block: true,
          blockReason: blockable.map((v) => v.detail).join("; "),
        };
      }
    }
  };

  const afterHandler = (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext): void => {
    const key = pendingKey(ctx);
    const queue = pendingCalls.get(key);
    const record = queue?.shift();

    if (queue?.length === 0) {
      pendingCalls.delete(key);
    }

    // Classify result categories (result may be a string, object, or null)
    let resultCategories: DataCategory[] | undefined;
    if (event.result !== null && event.result !== undefined) {
      const resultObj =
        typeof event.result === "object"
          ? (event.result as Record<string, unknown>)
          : { result: event.result };
      resultCategories = classifyParams(resultObj);
    }

    // Truncate result for audit log — never store raw PII
    const resultSummary =
      event.result !== undefined ? JSON.stringify(event.result).slice(0, 200) : undefined;

    const entry: AuditEntry = {
      id: record?.callId ?? crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolName: event.toolName,
      params: event.params,
      paramCategories: record?.paramCategories ?? classifyParams(event.params),
      resultSummary,
      resultCategories,
      durationMs: record ? Date.now() - record.startedAt : event.durationMs,
      error: event.error,
      consentScope: record?.consentScope ?? "implicit",
      violations: record?.violations ?? [],
    };

    // Fire-and-forget: never await in the synchronous hook path
    void store.append(entry);
  };

  return [
    {
      pluginId: PLUGIN_ID,
      hookName: "before_tool_call",
      handler: beforeHandler,
      source: SOURCE,
    } as PluginHookRegistration<"before_tool_call">,
    {
      pluginId: PLUGIN_ID,
      hookName: "after_tool_call",
      handler: afterHandler,
      source: SOURCE,
    } as PluginHookRegistration<"after_tool_call">,
  ];
}
