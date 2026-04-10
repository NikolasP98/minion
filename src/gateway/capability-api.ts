/**
 * Combined capability API handler — dispatches to admin and tenant
 * capability handlers. Single entry point for the HTTP server chain.
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityFlagEvaluator } from "../capabilities/capability-flag-evaluator.js";
import { createCapabilityAdminHandler } from "./capability-admin.js";
import { createCapabilityTenantHandler } from "./capability-tenant.js";

// ── DB type ───────────────────────────────────────────────────────────────────

type DatabaseSync = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
};

// ── Factory ───────────────────────────────────────────────────────────────────

export function createCapabilityApiHandler(opts: {
  db: DatabaseSync;
  evaluator: CapabilityFlagEvaluator;
  extractTenantId: (req: IncomingMessage) => string | null;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const adminHandler = createCapabilityAdminHandler(opts.db, opts.evaluator);
  const tenantHandler = createCapabilityTenantHandler(
    opts.db,
    opts.evaluator,
    opts.extractTenantId,
  );

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (await adminHandler(req, res)) {
      return true;
    }
    if (await tenantHandler(req, res)) {
      return true;
    }
    return false;
  };
}
