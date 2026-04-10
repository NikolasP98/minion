/**
 * Tenant self-serve capability API — tenant-facing endpoints for viewing
 * capabilities, tier comparison, and upgrade flow.
 *
 * Routes:
 *   GET  /api/v1/tenant/capabilities
 *   GET  /api/v1/tenant/tiers
 *   POST /api/v1/tenant/upgrade
 *   GET  /api/v1/tenant/capabilities/history
 *
 * Auth: tenant JWT (standard auth middleware — tenantId extracted from token).
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityFlagEvaluator } from "../capabilities/capability-flag-evaluator.js";
import type { CapabilityTierName } from "../capabilities/capability-manifest.types.js";
import * as repo from "../capabilities/capability-repository.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/capability-tenant");

// ── DB type ───────────────────────────────────────────────────────────────────

type DatabaseSync = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ── Tier ordering ─────────────────────────────────────────────────────────────

const TIER_ORDER: Record<CapabilityTierName, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

// ── Handler factory ───────────────────────────────────────────────────────────

export function createCapabilityTenantHandler(
  db: DatabaseSync,
  evaluator: CapabilityFlagEvaluator,
  extractTenantId: (req: IncomingMessage) => string | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (
      !pathname.startsWith("/api/v1/tenant/capabilities") &&
      !pathname.startsWith("/api/v1/tenant/tiers") &&
      !pathname.startsWith("/api/v1/tenant/upgrade")
    ) {
      return false;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return true;
    }

    const tenantId = extractTenantId(req);
    if (!tenantId) {
      sendJson(res, 401, { error: "unauthorized", message: "Missing tenant context" });
      return true;
    }

    try {
      // GET /api/v1/tenant/capabilities
      if (req.method === "GET" && pathname === "/api/v1/tenant/capabilities") {
        const manifest = await evaluator.resolve(tenantId);
        sendJson(res, 200, manifest);
        return true;
      }

      // GET /api/v1/tenant/capabilities/history
      if (req.method === "GET" && pathname === "/api/v1/tenant/capabilities/history") {
        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const entries = repo.getAuditLog(db, tenantId, limit);
        sendJson(res, 200, { tenantId, entries });
        return true;
      }

      // GET /api/v1/tenant/tiers
      if (req.method === "GET" && pathname === "/api/v1/tenant/tiers") {
        const tiers = repo.listTiers(db);
        const manifest = await evaluator.resolve(tenantId);
        const currentTier = manifest.tier;

        const tiersWithAnnotations = tiers.map((tier) => {
          let capabilities: unknown;
          try {
            capabilities = JSON.parse(tier.capabilities);
          } catch {
            capabilities = {};
          }
          return {
            id: tier.id,
            name: tier.name,
            capabilities,
            isCurrent: tier.name === currentTier,
            isUpgrade: TIER_ORDER[tier.name] > TIER_ORDER[currentTier],
            isDowngrade: TIER_ORDER[tier.name] < TIER_ORDER[currentTier],
          };
        });

        sendJson(res, 200, { currentTier, tiers: tiersWithAnnotations });
        return true;
      }

      // POST /api/v1/tenant/upgrade
      if (req.method === "POST" && pathname === "/api/v1/tenant/upgrade") {
        const body = (await readJsonBody(req)) as { targetTier?: string };
        const targetTierName = body.targetTier as CapabilityTierName | undefined;

        if (!targetTierName || !TIER_ORDER[targetTierName]) {
          sendJson(res, 400, { error: "invalid_tier", message: "Provide a valid targetTier" });
          return true;
        }

        const manifest = await evaluator.resolve(tenantId);
        if (TIER_ORDER[targetTierName] <= TIER_ORDER[manifest.tier]) {
          sendJson(res, 400, {
            error: "invalid_upgrade",
            message: `Cannot upgrade from ${manifest.tier} to ${targetTierName}`,
          });
          return true;
        }

        // Billing stub — returns a placeholder checkout URL
        const checkoutUrl = `https://billing.minion.ai/checkout?tenant=${tenantId}&tier=${targetTierName}`;
        log.info(`Upgrade request: tenant=${tenantId} from=${manifest.tier} to=${targetTierName}`);

        sendJson(res, 200, { checkoutUrl });
        return true;
      }
    } catch (err) {
      log.error(`Capability tenant API error: ${String(err)}`);
      sendJson(res, 500, { error: "internal_error", message: String(err) });
      return true;
    }

    return false;
  };
}
