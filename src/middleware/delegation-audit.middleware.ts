/**
 * Delegation audit middleware — logs every authenticated request's
 * `act` delegation chain to the `agent_delegation_audit_log` table.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  fingerprintChain,
  getDelegationDepth,
  type DelegationChain,
} from "../auth/delegation-token.js";
import { logDebug } from "../logger.js";

// ── Schema ────────────────────────────────────────────────────────────

/**
 * Create the delegation audit log table if it doesn't exist.
 */
export function ensureDelegationAuditSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_delegation_audit_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      chain_fingerprint TEXT NOT NULL,
      principal_depth INTEGER NOT NULL,
      tool_scope TEXT,
      raw_chain TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dal_tenant_id
      ON agent_delegation_audit_log(tenant_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dal_created_at
      ON agent_delegation_audit_log(created_at);
  `);
}

// ── Audit logger ──────────────────────────────────────────────────────

/**
 * Extract the tenant ID from a delegation chain by walking the `act` links
 * and finding the first principal with role "tenant".
 */
function extractTenantId(chain: DelegationChain): string {
  let current: DelegationChain | undefined = chain;
  while (current) {
    if (current.role === "tenant") {
      return current.sub;
    }
    current = current.act;
  }
  return "unknown";
}

/**
 * Log a delegation chain to the audit table.
 *
 * This function is the core of the middleware — call it on every
 * authenticated request that carries a delegation chain.
 */
export function logDelegationAudit(db: DatabaseSync, chain: DelegationChain): void {
  const id = randomUUID();
  const tenantId = extractTenantId(chain);
  const fingerprint = fingerprintChain(chain);
  const depth = getDelegationDepth(chain);
  const toolScope = chain.role === "tool" ? (chain.scope ?? null) : null;
  const rawChain = JSON.stringify(chain);

  const stmt = db.prepare(
    `INSERT INTO agent_delegation_audit_log
       (id, tenant_id, chain_fingerprint, principal_depth, tool_scope, raw_chain)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(id, tenantId, fingerprint, depth, toolScope, rawChain);

  logDebug(
    `auth: delegation audit logged — depth=${depth} tenant=${tenantId} fingerprint=${fingerprint.slice(0, 12)}…`,
  );
}
