/**
 * Admin capability API — operator-only endpoints for managing tiers,
 * tenant capabilities, overrides, and audit logs.
 *
 * Routes:
 *   GET  /api/admin/tiers
 *   PUT  /api/admin/tiers/:tierId
 *   GET  /api/admin/tenants/:tenantId/capabilities
 *   PUT  /api/admin/tenants/:tenantId/tier
 *   POST /api/admin/tenants/:tenantId/overrides
 *   DEL  /api/admin/tenants/:tenantId/overrides/:key
 *   GET  /api/admin/tenants/:tenantId/audit
 *
 * Auth: operator JWT only (checked by caller before dispatching here).
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityFlagEvaluator } from "../capabilities/capability-flag-evaluator.js";
import * as repo from "../capabilities/capability-repository.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/capability-admin");

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
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
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

function generateId(): string {
  return crypto.randomUUID();
}

// ── Route patterns ────────────────────────────────────────────────────────────

const TIERS_PATH = "/api/admin/tiers";
const TIER_PATH_RE = /^\/api\/admin\/tiers\/([^/]+)$/;
const TENANT_CAPS_PATH_RE = /^\/api\/admin\/tenants\/([^/]+)\/capabilities$/;
const TENANT_TIER_PATH_RE = /^\/api\/admin\/tenants\/([^/]+)\/tier$/;
const TENANT_OVERRIDES_PATH_RE = /^\/api\/admin\/tenants\/([^/]+)\/overrides$/;
const TENANT_OVERRIDE_KEY_PATH_RE = /^\/api\/admin\/tenants\/([^/]+)\/overrides\/([^/]+)$/;
const TENANT_AUDIT_PATH_RE = /^\/api\/admin\/tenants\/([^/]+)\/audit$/;

// ── Handler factory ───────────────────────────────────────────────────────────

export function createCapabilityAdminHandler(
  db: DatabaseSync,
  evaluator: CapabilityFlagEvaluator,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/admin/tiers") && !pathname.startsWith("/api/admin/tenants")) {
      return false;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return true;
    }

    try {
      // GET /api/admin/tiers
      if (req.method === "GET" && pathname === TIERS_PATH) {
        const tiers = repo.listTiers(db);
        sendJson(res, 200, { tiers });
        return true;
      }

      // PUT /api/admin/tiers/:tierId
      const tierMatch = pathname.match(TIER_PATH_RE);
      if (req.method === "PUT" && tierMatch) {
        const tierId = tierMatch[1];
        const body = (await readJsonBody(req)) as { name?: string; capabilities?: unknown };
        const existing = repo.getTierById(db, tierId);
        if (!existing) {
          sendJson(res, 404, { error: "tier_not_found", tierId });
          return true;
        }
        repo.upsertTier(db, {
          id: tierId,
          name: body.name ? (body.name as "free" | "pro" | "enterprise") : existing.name,
          capabilities: body.capabilities
            ? JSON.stringify(body.capabilities)
            : existing.capabilities,
        });
        evaluator.invalidateByTier(tierId);
        sendJson(res, 200, { ok: true, tierId });
        return true;
      }

      // GET /api/admin/tenants/:tenantId/capabilities
      const capsMatch = pathname.match(TENANT_CAPS_PATH_RE);
      if (req.method === "GET" && capsMatch) {
        const tenantId = capsMatch[1];
        const manifest = await evaluator.resolve(tenantId);
        sendJson(res, 200, manifest);
        return true;
      }

      // PUT /api/admin/tenants/:tenantId/tier
      const tierSetMatch = pathname.match(TENANT_TIER_PATH_RE);
      if (req.method === "PUT" && tierSetMatch) {
        const tenantId = tierSetMatch[1];
        const body = (await readJsonBody(req)) as { tierId: string; changedBy: string };
        if (!body.tierId || !body.changedBy) {
          sendJson(res, 400, { error: "missing_fields", required: ["tierId", "changedBy"] });
          return true;
        }
        const tier = repo.getTierById(db, body.tierId);
        if (!tier) {
          sendJson(res, 404, { error: "tier_not_found", tierId: body.tierId });
          return true;
        }
        const existing = repo.getTenantCapabilities(db, tenantId);
        const oldTierName = existing ? (repo.getTierById(db, existing.tierId)?.name ?? null) : null;

        repo.setTenantTier(db, {
          id: generateId(),
          tenantId,
          tierId: body.tierId,
          changedBy: body.changedBy,
        });
        repo.appendAuditLog(db, {
          id: generateId(),
          tenantId,
          oldTier: oldTierName,
          newTier: tier.name,
          changedBy: body.changedBy,
          overrideDiff: null,
        });
        evaluator.invalidate(tenantId);
        sendJson(res, 200, { ok: true, tenantId, tier: tier.name });
        return true;
      }

      // POST /api/admin/tenants/:tenantId/overrides
      const overridesMatch = pathname.match(TENANT_OVERRIDES_PATH_RE);
      if (req.method === "POST" && overridesMatch) {
        const tenantId = overridesMatch[1];
        const body = (await readJsonBody(req)) as {
          key: string;
          value: unknown;
          changedBy: string;
        };
        if (!body.key || body.value === undefined || !body.changedBy) {
          sendJson(res, 400, { error: "missing_fields", required: ["key", "value", "changedBy"] });
          return true;
        }
        repo.setTenantOverrides(db, { tenantId, key: body.key, value: body.value });
        repo.appendAuditLog(db, {
          id: generateId(),
          tenantId,
          oldTier: null,
          newTier: null,
          changedBy: body.changedBy,
          overrideDiff: JSON.stringify({ set: { [body.key]: body.value } }),
        });
        evaluator.invalidate(tenantId);
        sendJson(res, 200, { ok: true, tenantId, key: body.key });
        return true;
      }

      // DEL /api/admin/tenants/:tenantId/overrides/:key
      const overrideKeyMatch = pathname.match(TENANT_OVERRIDE_KEY_PATH_RE);
      if (req.method === "DELETE" && overrideKeyMatch) {
        const tenantId = overrideKeyMatch[1];
        const key = overrideKeyMatch[2];
        const body = req.headers["content-length"]
          ? ((await readJsonBody(req)) as { changedBy?: string })
          : {};
        const changedBy = body.changedBy ?? "admin";
        repo.deleteTenantOverride(db, { tenantId, key });
        repo.appendAuditLog(db, {
          id: generateId(),
          tenantId,
          oldTier: null,
          newTier: null,
          changedBy,
          overrideDiff: JSON.stringify({ removed: key }),
        });
        evaluator.invalidate(tenantId);
        sendJson(res, 200, { ok: true, tenantId, removedKey: key });
        return true;
      }

      // GET /api/admin/tenants/:tenantId/audit
      const auditMatch = pathname.match(TENANT_AUDIT_PATH_RE);
      if (req.method === "GET" && auditMatch) {
        const tenantId = auditMatch[1];
        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const entries = repo.getAuditLog(db, tenantId, limit);
        sendJson(res, 200, { tenantId, entries });
        return true;
      }
    } catch (err) {
      log.error(`Capability admin API error: ${String(err)}`);
      sendJson(res, 500, { error: "internal_error", message: String(err) });
      return true;
    }

    return false;
  };
}
