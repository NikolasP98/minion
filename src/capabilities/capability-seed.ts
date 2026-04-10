/**
 * Capability tier seed data — seeds Free, Pro, Enterprise tiers
 * with capability values from the MIN-456 product spec.
 *
 * Called at server startup if the tiers table is empty.
 * Idempotent — skips seeding if tiers already exist.
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CapabilitySet } from "./capability-manifest.types.js";
import { listTiers, upsertTier } from "./capability-repository.js";

const log = createSubsystemLogger("capabilities/seed");

// ── DB type ───────────────────────────────────────────────────────────────────

type DatabaseSync = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
};

// ── Tier definitions from MIN-456 product spec ────────────────────────────────

const FREE_CAPABILITIES: CapabilitySet = {
  channels: { slack: false, teams: false, email: false, api: true, webhook: false },
  models: {
    tier: "basic",
    allowedModels: ["claude-haiku-4-5"],
    maxContextWindow: 32_000,
  },
  rateLimits: {
    requestsPerMinute: 10,
    agentsPerWorkspace: 3,
    tasksPerDay: 50,
  },
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

const PRO_CAPABILITIES: CapabilitySet = {
  channels: { slack: true, teams: true, email: false, api: true, webhook: false },
  models: {
    tier: "standard",
    allowedModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    maxContextWindow: 100_000,
  },
  rateLimits: {
    requestsPerMinute: 60,
    agentsPerWorkspace: 10,
    tasksPerDay: 500,
  },
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

const ENTERPRISE_CAPABILITIES: CapabilitySet = {
  channels: { slack: true, teams: true, email: true, api: true, webhook: true },
  models: {
    tier: "advanced",
    allowedModels: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"],
    maxContextWindow: 1_000_000,
  },
  rateLimits: {
    requestsPerMinute: 500,
    agentsPerWorkspace: 999_999,
    tasksPerDay: 999_999,
  },
  features: {
    customAgentPersonas: true,
    advancedAnalytics: true,
    apiAccess: true,
    ssoIntegration: true,
    auditLogs: true,
    prioritySupport: true,
    whiteLabel: true,
    dataExport: true,
  },
  integrations: { github: true, linear: true, jira: true, salesforce: true },
};

// ── Deterministic UUIDs for seed data ─────────────────────────────────────────

const TIER_IDS = {
  free: "c0000000-0000-4000-8000-000000000001",
  pro: "c0000000-0000-4000-8000-000000000002",
  enterprise: "c0000000-0000-4000-8000-000000000003",
} as const;

// ── Seed function ─────────────────────────────────────────────────────────────

export function seedCapabilityTiers(db: DatabaseSync): void {
  const existing = listTiers(db);
  if (existing.length > 0) {
    log.info(`Capability tiers already seeded (${existing.length} tiers found), skipping`);
    return;
  }

  log.info("Seeding capability tiers: free, pro, enterprise");

  upsertTier(db, {
    id: TIER_IDS.free,
    name: "free",
    capabilities: JSON.stringify(FREE_CAPABILITIES),
  });

  upsertTier(db, {
    id: TIER_IDS.pro,
    name: "pro",
    capabilities: JSON.stringify(PRO_CAPABILITIES),
  });

  upsertTier(db, {
    id: TIER_IDS.enterprise,
    name: "enterprise",
    capabilities: JSON.stringify(ENTERPRISE_CAPABILITIES),
  });

  log.info("Capability tiers seeded successfully");
}

export { TIER_IDS, FREE_CAPABILITIES, PRO_CAPABILITIES, ENTERPRISE_CAPABILITIES };
