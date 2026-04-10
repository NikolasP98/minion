/**
 * Capability tier repository — CRUD operations for capability tiers,
 * tenant assignments, and audit logging.
 *
 * Follows the typed-schema.ts repository pattern: accepts explicit db handle,
 * uses node:sqlite DatabaseSync, TEXT UUIDs, ISO-8601 date strings.
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import type {
  AuditLogRow,
  CapabilityTierName,
  TenantCapabilitiesRow,
  TierRow,
} from "./capability-manifest.types.js";

// ── DB type ───────────────────────────────────────────────────────────────────

type DatabaseSync = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
};

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToTier(row: Record<string, unknown>): TierRow {
  return {
    id: String(row["id"]),
    name: row["name"] as CapabilityTierName,
    capabilities: String(row["capabilities"]),
    version: Number(row["version"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function rowToTenantCapabilities(row: Record<string, unknown>): TenantCapabilitiesRow {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    tierId: String(row["tier_id"]),
    overrides: String(row["overrides"]),
    effectiveAt: String(row["effective_at"]),
    changedBy: String(row["changed_by"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function rowToAuditLog(row: Record<string, unknown>): AuditLogRow {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    changedAt: String(row["changed_at"]),
    oldTier: row["old_tier"] == null ? null : (row["old_tier"] as string),
    newTier: row["new_tier"] == null ? null : (row["new_tier"] as string),
    changedBy: String(row["changed_by"]),
    overrideDiff: row["override_diff"] == null ? null : (row["override_diff"] as string),
  };
}

// ── Tier CRUD ─────────────────────────────────────────────────────────────────

export function getTierById(db: DatabaseSync, tierId: string): TierRow | null {
  const row = db.prepare("SELECT * FROM capability_tiers WHERE id = ?").get(tierId);
  return row ? rowToTier(row) : null;
}

export function getTierByName(db: DatabaseSync, name: CapabilityTierName): TierRow | null {
  const row = db.prepare("SELECT * FROM capability_tiers WHERE name = ?").get(name);
  return row ? rowToTier(row) : null;
}

export function listTiers(db: DatabaseSync): TierRow[] {
  const rows = db.prepare("SELECT * FROM capability_tiers ORDER BY name ASC").all();
  return rows.map(rowToTier);
}

export function upsertTier(
  db: DatabaseSync,
  tier: { id: string; name: CapabilityTierName; capabilities: string },
): void {
  const now = new Date().toISOString();
  const existing = getTierById(db, tier.id);
  if (existing) {
    db.prepare(
      `UPDATE capability_tiers SET name = ?, capabilities = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(tier.name, tier.capabilities, now, tier.id);
  } else {
    db.prepare(
      `INSERT INTO capability_tiers (id, name, capabilities, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(tier.id, tier.name, tier.capabilities, now, now);
  }
}

// ── Tenant capabilities CRUD ──────────────────────────────────────────────────

export function getTenantCapabilities(
  db: DatabaseSync,
  tenantId: string,
): TenantCapabilitiesRow | null {
  const row = db.prepare("SELECT * FROM tenant_capabilities WHERE tenant_id = ?").get(tenantId);
  return row ? rowToTenantCapabilities(row) : null;
}

export function setTenantTier(
  db: DatabaseSync,
  params: { id: string; tenantId: string; tierId: string; changedBy: string },
): void {
  const now = new Date().toISOString();
  const existing = getTenantCapabilities(db, params.tenantId);
  if (existing) {
    db.prepare(
      `UPDATE tenant_capabilities SET tier_id = ?, changed_by = ?, effective_at = ?, updated_at = ? WHERE tenant_id = ?`,
    ).run(params.tierId, params.changedBy, now, now, params.tenantId);
  } else {
    db.prepare(
      `INSERT INTO tenant_capabilities (id, tenant_id, tier_id, overrides, effective_at, changed_by, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`,
    ).run(params.id, params.tenantId, params.tierId, now, params.changedBy, now, now);
  }
}

export function setTenantOverrides(
  db: DatabaseSync,
  params: { tenantId: string; key: string; value: unknown },
): void {
  const now = new Date().toISOString();
  const existing = getTenantCapabilities(db, params.tenantId);
  if (!existing) {
    return;
  }
  let overrides: Record<string, unknown>;
  try {
    overrides = JSON.parse(existing.overrides) as Record<string, unknown>;
  } catch {
    overrides = {};
  }
  overrides[params.key] = params.value;
  db.prepare(
    `UPDATE tenant_capabilities SET overrides = ?, updated_at = ? WHERE tenant_id = ?`,
  ).run(JSON.stringify(overrides), now, params.tenantId);
}

export function deleteTenantOverride(
  db: DatabaseSync,
  params: { tenantId: string; key: string },
): void {
  const now = new Date().toISOString();
  const existing = getTenantCapabilities(db, params.tenantId);
  if (!existing) {
    return;
  }
  let overrides: Record<string, unknown>;
  try {
    overrides = JSON.parse(existing.overrides) as Record<string, unknown>;
  } catch {
    overrides = {};
  }
  delete overrides[params.key];
  db.prepare(
    `UPDATE tenant_capabilities SET overrides = ?, updated_at = ? WHERE tenant_id = ?`,
  ).run(JSON.stringify(overrides), now, params.tenantId);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export function appendAuditLog(
  db: DatabaseSync,
  entry: {
    id: string;
    tenantId: string;
    oldTier: string | null;
    newTier: string | null;
    changedBy: string;
    overrideDiff: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO capability_audit_log (id, tenant_id, changed_at, old_tier, new_tier, changed_by, override_diff) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.tenantId,
    now,
    entry.oldTier,
    entry.newTier,
    entry.changedBy,
    entry.overrideDiff,
  );
}

export function getAuditLog(db: DatabaseSync, tenantId: string, limit = 50): AuditLogRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM capability_audit_log WHERE tenant_id = ? ORDER BY changed_at DESC LIMIT ?",
    )
    .all(tenantId, limit);
  return rows.map(rowToAuditLog);
}
