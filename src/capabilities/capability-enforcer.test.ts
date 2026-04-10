import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySqlitePragmas } from "../memory/sqlite-pragmas.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { createCapabilityEnforcer, checkToolCapability } from "./capability-enforcer.js";
import { CapabilityFlagEvaluator } from "./capability-flag-evaluator.js";
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
  upsertTier(db as never, { id: "tier-pro", name: "pro", capabilities: JSON.stringify(PRO_CAPS) });
}

function mockResponse(): ServerResponse & { _body: string; _status: number } {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    _body: "",
    _status: 200,
    setHeader: vi.fn((key: string, value: string) => headers.set(key, value)),
    end: vi.fn((body?: string) => {
      res._body = body ?? "";
      res._status = res.statusCode;
    }),
  };
  return res as unknown as ServerResponse & { _body: string; _status: number };
}

let db: ReturnType<typeof createTestDb>;

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
});

describe("createCapabilityEnforcer", () => {
  it("allows request when capability is present", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const enforce = createCapabilityEnforcer(evaluator, {
      extractTenantId: () => "acme",
    });

    const req = {} as IncomingMessage;
    const res = mockResponse();
    const allowed = await enforce(req, res, "channels.slack");
    expect(allowed).toBe(true);
    expect(res._body).toBe("");
  });

  it("denies request with structured error JSON when capability is missing", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const enforce = createCapabilityEnforcer(evaluator, {
      extractTenantId: () => "acme",
    });

    const req = {} as IncomingMessage;
    const res = mockResponse();
    const allowed = await enforce(req, res, "channels.slack");
    expect(allowed).toBe(false);
    expect(res._status).toBe(403);

    const body = JSON.parse(res._body);
    expect(body.error).toBe("capability_required");
    expect(body.capability).toBe("channels.slack");
    expect(body.requiredTier).toBe("pro");
    expect(body.upgradeUrl).toBe("/api/v1/tenant/upgrade");
  });

  it("allows request when no tenant context (tenant-scoped system)", async () => {
    db = createTestDb();
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const enforce = createCapabilityEnforcer(evaluator, {
      extractTenantId: () => null,
    });

    const req = {} as IncomingMessage;
    const res = mockResponse();
    const allowed = await enforce(req, res, "channels.slack");
    expect(allowed).toBe(true);
  });
});

describe("checkToolCapability", () => {
  it("returns { blocked: false } when capability is allowed", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-pro",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const result = await checkToolCapability(evaluator, "acme", "channels.slack");
    expect(result.blocked).toBe(false);
  });

  it("returns { blocked: true, reason } when capability is denied", async () => {
    db = createTestDb();
    seedTiers(db);
    setTenantTier(db as never, {
      id: "tc-1",
      tenantId: "acme",
      tierId: "tier-free",
      changedBy: "admin",
    });
    const evaluator = new CapabilityFlagEvaluator(db as never);
    const result = await checkToolCapability(evaluator, "acme", "channels.slack");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("pro");
      expect(result.reason).toContain("upgrade");
    }
  });
});
