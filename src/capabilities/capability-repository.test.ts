import { afterEach, describe, expect, it } from "vitest";
import { applySqlitePragmas } from "../memory/sqlite-pragmas.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import {
  appendAuditLog,
  deleteTenantOverride,
  getAuditLog,
  getTenantCapabilities,
  getTierById,
  getTierByName,
  listTiers,
  setTenantOverrides,
  setTenantTier,
  upsertTier,
} from "./capability-repository.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS capability_tiers (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE CHECK(name IN ('free', 'pro', 'enterprise')),
  capabilities TEXT    NOT NULL DEFAULT '{}',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_capabilities (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL UNIQUE,
  tier_id      TEXT    NOT NULL REFERENCES capability_tiers(id),
  overrides    TEXT    NOT NULL DEFAULT '{}',
  effective_at TEXT    NOT NULL,
  changed_by   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_audit_log (
  id            TEXT    PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  changed_at    TEXT    NOT NULL,
  old_tier      TEXT,
  new_tier      TEXT,
  changed_by    TEXT    NOT NULL,
  override_diff TEXT
);
`;

type DatabaseSync = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

function createTestDb(): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:") as unknown as DatabaseSync;
  applySqlitePragmas(db as unknown as { exec(sql: string): void });
  (db as unknown as { exec(sql: string): void }).exec("PRAGMA foreign_keys = ON");
  (db as unknown as { exec(sql: string): void }).exec(MIGRATION_SQL);
  return db;
}

let db: DatabaseSync;

afterEach(() => {
  try {
    (db as unknown as { close(): void }).close();
  } catch {
    // ignore
  }
});

describe("capability-repository: tiers", () => {
  it("upsertTier creates a new tier and getTierById retrieves it", () => {
    db = createTestDb();
    upsertTier(db as never, {
      id: "tier-1",
      name: "free",
      capabilities: JSON.stringify({ channels: { api: true } }),
    });
    const tier = getTierById(db as never, "tier-1");
    expect(tier).not.toBeNull();
    expect(tier!.name).toBe("free");
    expect(tier!.version).toBe(1);
    expect(JSON.parse(tier!.capabilities)).toEqual({ channels: { api: true } });
  });

  it("upsertTier updates an existing tier and increments version", () => {
    db = createTestDb();
    upsertTier(db as never, {
      id: "tier-1",
      name: "free",
      capabilities: JSON.stringify({ channels: { api: true } }),
    });
    upsertTier(db as never, {
      id: "tier-1",
      name: "free",
      capabilities: JSON.stringify({ channels: { api: true, slack: true } }),
    });
    const tier = getTierById(db as never, "tier-1");
    expect(tier!.version).toBe(2);
    expect(JSON.parse(tier!.capabilities)).toEqual({ channels: { api: true, slack: true } });
  });

  it("getTierByName returns correct tier", () => {
    db = createTestDb();
    upsertTier(db as never, {
      id: "tier-pro",
      name: "pro",
      capabilities: "{}",
    });
    const tier = getTierByName(db as never, "pro");
    expect(tier).not.toBeNull();
    expect(tier!.id).toBe("tier-pro");
  });

  it("getTierById returns null for non-existent tier", () => {
    db = createTestDb();
    const tier = getTierById(db as never, "nonexistent");
    expect(tier).toBeNull();
  });

  it("listTiers returns all tiers sorted by name", () => {
    db = createTestDb();
    upsertTier(db as never, { id: "t1", name: "pro", capabilities: "{}" });
    upsertTier(db as never, { id: "t2", name: "free", capabilities: "{}" });
    upsertTier(db as never, { id: "t3", name: "enterprise", capabilities: "{}" });
    const tiers = listTiers(db as never);
    expect(tiers).toHaveLength(3);
    expect(tiers.map((t) => t.name)).toEqual(["enterprise", "free", "pro"]);
  });
});

describe("capability-repository: tenant capabilities", () => {
  it("setTenantTier creates a new tenant assignment", () => {
    db = createTestDb();
    upsertTier(db as never, { id: "tier-free", name: "free", capabilities: "{}" });
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    const tc = getTenantCapabilities(db as never, "acme");
    expect(tc).not.toBeNull();
    expect(tc!.tierId).toBe("tier-free");
    expect(tc!.changedBy).toBe("admin");
  });

  it("setTenantTier updates an existing tenant assignment", () => {
    db = createTestDb();
    upsertTier(db as never, { id: "tier-free", name: "free", capabilities: "{}" });
    upsertTier(db as never, { id: "tier-pro", name: "pro", capabilities: "{}" });
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    setTenantTier(db as never, {
      id: "tc-2",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "operator",
    });
    const tc = getTenantCapabilities(db as never, "acme");
    expect(tc!.tierId).toBe("tier-pro");
    expect(tc!.changedBy).toBe("operator");
  });

  it("setTenantOverrides adds an override key", () => {
    db = createTestDb();
    upsertTier(db as never, { id: "tier-free", name: "free", capabilities: "{}" });
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    setTenantOverrides(db as never, {
      tenantId: "acme",
      key: "channels",
      value: { slack: true },
    });
    const tc = getTenantCapabilities(db as never, "acme");
    const overrides = JSON.parse(tc!.overrides);
    expect(overrides.channels).toEqual({ slack: true });
  });

  it("deleteTenantOverride removes an override key", () => {
    db = createTestDb();
    upsertTier(db as never, { id: "tier-free", name: "free", capabilities: "{}" });
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    setTenantOverrides(db as never, {
      tenantId: "acme",
      key: "channels",
      value: { slack: true },
    });
    deleteTenantOverride(db as never, { tenantId: "acme", key: "channels" });
    const tc = getTenantCapabilities(db as never, "acme");
    const overrides = JSON.parse(tc!.overrides);
    expect(overrides.channels).toBeUndefined();
  });

  it("getTenantCapabilities returns null for unassigned tenant", () => {
    db = createTestDb();
    const tc = getTenantCapabilities(db as never, "nonexistent");
    expect(tc).toBeNull();
  });
});

describe("capability-repository: audit log", () => {
  it("appendAuditLog creates an entry and getAuditLog retrieves it", () => {
    db = createTestDb();
    appendAuditLog(db as never, {
      id: "audit-1",
      tenantId: "acme",
      oldTier: "free",
      newTier: "pro",
      changedBy: "admin",
      overrideDiff: null,
    });
    const logs = getAuditLog(db as never, "acme");
    expect(logs).toHaveLength(1);
    expect(logs[0].oldTier).toBe("free");
    expect(logs[0].newTier).toBe("pro");
    expect(logs[0].changedBy).toBe("admin");
  });

  it("getAuditLog respects limit parameter", () => {
    db = createTestDb();
    for (let i = 0; i < 10; i++) {
      appendAuditLog(db as never, {
        id: `audit-${i}`,
        tenantId: "acme",
        oldTier: null,
        newTier: null,
        changedBy: "admin",
        overrideDiff: null,
      });
    }
    const logs = getAuditLog(db as never, "acme", 3);
    expect(logs).toHaveLength(3);
  });

  it("getAuditLog returns multiple entries for same tenant", () => {
    db = createTestDb();
    appendAuditLog(db as never, {
      id: "audit-1",
      tenantId: "acme",
      oldTier: null,
      newTier: "free",
      changedBy: "admin",
      overrideDiff: null,
    });
    appendAuditLog(db as never, {
      id: "audit-2",
      tenantId: "acme",
      oldTier: "free",
      newTier: "pro",
      changedBy: "admin",
      overrideDiff: null,
    });
    const logs = getAuditLog(db as never, "acme");
    expect(logs).toHaveLength(2);
    const ids = logs.map((l) => l.id).toSorted();
    expect(ids).toEqual(["audit-1", "audit-2"]);
  });

  it("appendAuditLog stores override diffs", () => {
    db = createTestDb();
    const diff = JSON.stringify({ set: { "channels.slack": true } });
    appendAuditLog(db as never, {
      id: "audit-1",
      tenantId: "acme",
      oldTier: null,
      newTier: null,
      changedBy: "admin",
      overrideDiff: diff,
    });
    const logs = getAuditLog(db as never, "acme");
    expect(logs[0].overrideDiff).toBe(diff);
  });
});
