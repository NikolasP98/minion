import { afterEach, describe, expect, it } from "vitest";
import { applySqlitePragmas } from "../memory/sqlite-pragmas.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type { CapabilitySet } from "./capability-manifest.types.js";
import { listTiers } from "./capability-repository.js";
import { seedCapabilityTiers } from "./capability-seed.js";

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

function createTestDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  applySqlitePragmas(db as unknown as { exec(sql: string): void });
  (db as unknown as { exec(sql: string): void }).exec("PRAGMA foreign_keys = ON");
  (db as unknown as { exec(sql: string): void }).exec(MIGRATION_SQL);
  return db;
}

let db: ReturnType<typeof createTestDb>;

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
});

describe("seedCapabilityTiers", () => {
  it("seeds exactly 3 tiers on fresh DB", () => {
    db = createTestDb();
    seedCapabilityTiers(db as never);
    const tiers = listTiers(db as never);
    expect(tiers).toHaveLength(3);
    const names = tiers.map((t) => t.name).toSorted();
    expect(names).toEqual(["enterprise", "free", "pro"]);
  });

  it("is idempotent — does not duplicate tiers on second call", () => {
    db = createTestDb();
    seedCapabilityTiers(db as never);
    seedCapabilityTiers(db as never);
    const tiers = listTiers(db as never);
    expect(tiers).toHaveLength(3);
  });

  it("each tier has at least 8 capabilities", () => {
    db = createTestDb();
    seedCapabilityTiers(db as never);
    const tiers = listTiers(db as never);
    for (const tier of tiers) {
      const caps = JSON.parse(tier.capabilities) as CapabilitySet;
      // Count total leaf capabilities
      let count = 0;
      count += Object.keys(caps.channels).length;
      count += Object.keys(caps.models).length;
      count += Object.keys(caps.rateLimits).length;
      count += Object.keys(caps.features).length;
      count += Object.keys(caps.integrations).length;
      expect(count).toBeGreaterThanOrEqual(8);
    }
  });

  it("free tier has api: true and slack: false", () => {
    db = createTestDb();
    seedCapabilityTiers(db as never);
    const tiers = listTiers(db as never);
    const free = tiers.find((t) => t.name === "free");
    expect(free).toBeDefined();
    const caps = JSON.parse(free!.capabilities) as CapabilitySet;
    expect(caps.channels.api).toBe(true);
    expect(caps.channels.slack).toBe(false);
  });

  it("pro tier has slack: true and jira: false", () => {
    db = createTestDb();
    seedCapabilityTiers(db as never);
    const tiers = listTiers(db as never);
    const pro = tiers.find((t) => t.name === "pro");
    expect(pro).toBeDefined();
    const caps = JSON.parse(pro!.capabilities) as CapabilitySet;
    expect(caps.channels.slack).toBe(true);
    expect(caps.integrations.jira).toBe(false);
  });

  it("enterprise tier has all capabilities enabled", () => {
    db = createTestDb();
    seedCapabilityTiers(db as never);
    const tiers = listTiers(db as never);
    const ent = tiers.find((t) => t.name === "enterprise");
    expect(ent).toBeDefined();
    const caps = JSON.parse(ent!.capabilities) as CapabilitySet;
    expect(caps.channels.slack).toBe(true);
    expect(caps.channels.email).toBe(true);
    expect(caps.channels.webhook).toBe(true);
    expect(caps.features.ssoIntegration).toBe(true);
    expect(caps.features.auditLogs).toBe(true);
    expect(caps.integrations.jira).toBe(true);
    expect(caps.integrations.salesforce).toBe(true);
  });
});
