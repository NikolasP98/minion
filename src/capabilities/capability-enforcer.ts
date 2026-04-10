/**
 * Capability enforcer middleware — checks required capability for a
 * request and returns structured JSON error on denial.
 *
 * Never throws raw 403. Always returns:
 *   { error: "capability_required", capability, requiredTier, upgradeUrl }
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CapabilityFlagEvaluator } from "./capability-flag-evaluator.js";
import { CAPABILITY_ERROR_CODE } from "./capability-manifest.types.js";

const log = createSubsystemLogger("capabilities/enforcer");

// ── Telemetry ─────────────────────────────────────────────────────────────────

let upgradePromptsShown = 0;

export function getUpgradePromptCount(): number {
  return upgradePromptsShown;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CapabilityEnforcerOptions {
  /** Extract tenantId from the request. */
  extractTenantId: (req: IncomingMessage) => string | null;
}

export interface CapabilityCheckMiddleware {
  (req: IncomingMessage, res: ServerResponse, requiredCapability: string): Promise<boolean>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a capability enforcer that checks a required capability before
 * allowing the request to proceed.
 *
 * Returns a function that resolves to `true` if the request is allowed,
 * or `false` if denied (and the response has already been sent).
 */
export function createCapabilityEnforcer(
  evaluator: CapabilityFlagEvaluator,
  options: CapabilityEnforcerOptions,
): CapabilityCheckMiddleware {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    requiredCapability: string,
  ): Promise<boolean> => {
    const tenantId = options.extractTenantId(req);
    if (!tenantId) {
      // No tenant context — allow (capability system is tenant-scoped)
      return true;
    }

    const result = await evaluator.check(tenantId, requiredCapability);

    if (result.allowed) {
      return true;
    }

    upgradePromptsShown++;
    log.info(
      `Capability denied: tenant=${tenantId} capability=${requiredCapability} requiredTier=${result.requiredTier}`,
    );

    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: CAPABILITY_ERROR_CODE,
        capability: requiredCapability,
        requiredTier: result.requiredTier,
        upgradeUrl: result.upgradeUrl,
      }),
    );
    return false;
  };
}

// ── Tool-call enforcement ─────────────────────────────────────────────────────

/**
 * Check a capability for a tool call in the agent request pipeline.
 * Returns { blocked: true, reason } or { blocked: false } to match
 * the before-tool-call hook pattern.
 */
export async function checkToolCapability(
  evaluator: CapabilityFlagEvaluator,
  tenantId: string,
  capability: string,
): Promise<{ blocked: true; reason: string } | { blocked: false }> {
  const result = await evaluator.check(tenantId, capability);

  if (result.allowed) {
    return { blocked: false };
  }

  upgradePromptsShown++;
  return {
    blocked: true,
    reason: `This feature requires the ${result.requiredTier} tier. Upgrade at ${result.upgradeUrl}`,
  };
}
