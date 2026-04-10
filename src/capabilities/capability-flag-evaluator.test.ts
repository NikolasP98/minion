import { afterEach, describe, expect, it, vi } from "vitest";
import { applySqlitePragmas } from "../memory/sqlite-pragmas.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { CapabilityFlagEvaluator, getCapabilityMetrics } from "./capability-flag-evaluator.js";
import type { CapabilitySet } from "./capability-manifest.types.js";
import { upsertTier, setTenantTier } from "./capability-repository.js";

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

const FREE_CAPS: CapabilitySet = {
  channels: { slack: false, teams: false, email: false, api: true, webhook: false },
  models: { tier: "basic", allowedModels: ["claude-haiku-4-5"], maxContextWindow: 32_000 },
  rateLimits: { requestsPerMinute: 10, agentsPerWorkspace: 3, tasksPerDay: 50 },
  features: {
    customAgentPersonas: false,
    advancedAnalytics: false,
    apiAccess: false,
    ssoIntegration: false,
    auditLogs: false,
    prioritySupport: false,
    whiteLabel: false,
    dataExport: false,
  },
  integrations: { github: false, linear: false, jira: false, salesforce: false },
};

const PRO_CAPS: CapabilitySet = {
  channels: { slack: true, teams: true, email: false, api: true, webhook: false },
  models: {
    tier: "standard",
    allowedModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    maxContextWindow: 100_000,
  },
  rateLimits: { requestsPerMinute: 60, agentsPerWorkspace: 10, tasksPerDay: 500 },
  features: {
    customAgentPersonas: true,
    advancedAnalytics: true,
    apiAccess: true,
    ssoIntegration: false,
    auditLogs: false,
    prioritySupport: false,
    whiteLabel: false,
    dataExport: false,
  },
  integrations: { github: true, linear: true, jira: false, salesforce: false },
};

function createTestDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  applySqlitePragmas(db as unknown as { exec(sql: string): void });
  (db as unknown as { exec(sql: string): void }).exec("PRAGMA foreign_keys = ON");
  (db as unknown as { exec(sql: string): void }).exec(MIGRATION_SQL);
  return db;
}

function seedTiers(db: unknown): void {
  upsertTier(db as never, {
    id: "tier-free",
    name: "free",
    capabilities: JSON.stringify(FREE_CAPS),
  });
  upsertTier(db as never, {
    id: "tier-pro",
    name: "pro",
    capabilities: JSON.stringify(PRO_CAPS),
  });
}

let db: ReturnType<typeof createTestDb>;

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
});

describe("CapabilityFlagEvaluator: resolve", () => {
  it("returns free-tier default manifest for unassigned tenant", async () => {
    db = createTestDb();
    seedTiers(db);
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const manifest = await evaluator.resolve("unknown-tenant");
    expect(manifest.tier).toBe("free");
    expect(manifest.tenantId).toBe("unknown-tenant");
    expect(manifest.capabilities.channels.api).toBe(true);
    expect(manifest.capabilities.channels.slack).toBe(false);
  });

  it("returns resolved manifest for tenant with assigned tier", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const manifest = await evaluator.resolve("acme");
    expect(manifest.tier).toBe("pro");
    expect(manifest.capabilities.channels.slack).toBe(true);
    expect(manifest.capabilities.rateLimits.requestsPerMinute).toBe(60);
  });

  it("L1 cache hit returns same manifest on second call (fast path)", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);

    const m1 = await evaluator.resolve("acme");
    const start = performance.now();
    const m2 = await evaluator.resolve("acme");
    const elapsed = performance.now() - start;

    expect(m1).toBe(m2); // Same object reference (cached)
    expect(elapsed).toBeLessThan(5); // L1 cache should be < 5ms
  });

  it("invalidate clears L1 cache and forces DB re-read", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);

    const m1 = await evaluator.resolve("acme");
    expect(m1.tier).toBe("free");

    // Change tier directly in DB
    setTenantTier(db as never, {
      id: "tc-2",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });

    // Without invalidation, still returns cached
    const m2 = await evaluator.resolve("acme");
    expect(m2.tier).toBe("free"); // Still cached

    // After invalidation, returns updated
    evaluator.invalidate("acme");
    const m3 = await evaluator.resolve("acme");
    expect(m3.tier).toBe("pro");
  });
});

describe("CapabilityFlagEvaluator: check", () => {
  it("allows capability present in tenant tier", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const result = await evaluator.check("acme", "channels.slack");
    expect(result.allowed).toBe(true);
  });

  it("denies capability not in tenant tier and returns requiredTier", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const result = await evaluator.check("acme", "channels.slack");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.requiredTier).toBe("pro");
      expect(result.upgradeUrl).toBe("/api/v1/tenant/upgrade");
    }
  });

  it("allows numeric capabilities with value > 0", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const result = await evaluator.check("acme", "rateLimits.requestsPerMinute");
    expect(result.allowed).toBe(true);
  });

  it("records metrics for checks", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);

    await evaluator.check("acme", "channels.slack");
    await evaluator.check("acme", "channels.email");

    const metrics = getCapabilityMetrics();
    expect(metrics.checks.size).toBeGreaterThan(0);
    expect(metrics.latencySamples.length).toBeGreaterThan(0);
  });
});

describe("CapabilityFlagEvaluator: fail-safe", () => {
  it("returns last cached manifest when DB fails after successful read", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });

    const evaluator = new CapabilityFlagEvaluator(db as never);
    const m1 = await evaluator.resolve("acme");
    expect(m1.tier).toBe("pro");

    // Close DB to simulate failure
    db.close();
    evaluator.invalidate("acme");

    // Should fall back to last good cache
    const m2 = await evaluator.resolve("acme");
    expect(m2.tier).toBe("pro");
  });

  it("returns free-tier default when DB fails with no cache", async () => {
    db = createTestDb();
    // Don't seed tiers — close immediately
    db.close();

    // Create a new DB handle that will fail
    const { DatabaseSync } = requireNodeSqlite();
    const badDb = new DatabaseSync(":memory:");
    badDb.close();

    const evaluator = new CapabilityFlagEvaluator(badDb as never);
    const manifest = await evaluator.resolve("acme");
    // Should default to free tier, not throw
    expect(manifest.tier).toBe("free");
    expect(manifest.tenantId).toBe("acme");
  });
});

describe("CapabilityFlagEvaluator: L2 Redis cache", () => {
  it("reads from Redis on L1 miss", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });

    const redisStore = new Map<string, string>();
    const mockRedis = {
      get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        redisStore.delete(key);
      }),
    };

    const evaluator = new CapabilityFlagEvaluator(db as never, mockRedis);

    // First call populates both L1 and L2
    const m1 = await evaluator.resolve("acme");
    expect(m1.tier).toBe("pro");
    expect(mockRedis.set).toHaveBeenCalled();

    // Invalidate L1 only
    evaluator.invalidate("acme");

    // Second call should hit Redis (L2)
    const m2 = await evaluator.resolve("acme");
    expect(m2.tier).toBe("pro");
    // Redis.get called at least once more after invalidation
    expect(mockRedis.get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
