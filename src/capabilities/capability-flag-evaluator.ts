/**
 * Capability flag evaluator — L1/L2 cached manifest resolution with
 * fail-safe fallback and OTel-style metrics.
 *
 * Evaluation order:
 *   1. L1 in-process Map (30s TTL)
 *   2. L2 Redis cache (5min TTL) — only if Redis client injected
 *   3. DB query via repository (tier defaults merged with overrides)
 *   4. On DB error: return last good cached manifest (fail-safe)
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  CapabilityCheckResult,
  CapabilityManifest,
  CapabilityOverrides,
  CapabilitySet,
  CapabilityTierName,
} from "./capability-manifest.types.js";
import * as repo from "./capability-repository.js";

const log = createSubsystemLogger("capabilities");

// ── Metrics counters (Prometheus-compatible) ──────────────────────────────────

const checkCounters = new Map<string, number>();
const latencySamples: number[] = [];
const MAX_LATENCY_SAMPLES = 10_000;

export function getCapabilityMetrics(): {
  checks: Map<string, number>;
  latencySamples: number[];
} {
  return { checks: checkCounters, latencySamples: [...latencySamples] };
}

function recordMetric(capability: string, tierName: string, result: "allowed" | "denied"): void {
  const key = `${capability}|${tierName}|${result}`;
  checkCounters.set(key, (checkCounters.get(key) ?? 0) + 1);
}

function recordLatency(ms: number): void {
  latencySamples.push(ms);
  if (latencySamples.length > MAX_LATENCY_SAMPLES) {
    latencySamples.splice(0, latencySamples.length - MAX_LATENCY_SAMPLES);
  }
}

// ── Redis client interface ────────────────────────────────────────────────────

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// ── DB type ───────────────────────────────────────────────────────────────────

type DatabaseSync = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
};

// ── Cache entry ───────────────────────────────────────────────────────────────

interface CacheEntry {
  manifest: CapabilityManifest;
  expiresAt: number;
}

// ── Default manifest (Free tier fallback) ─────────────────────────────────────

const FREE_TIER_CAPABILITIES: CapabilitySet = {
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

function createDefaultManifest(tenantId: string): CapabilityManifest {
  return {
    tenantId,
    tier: "free",
    resolvedAt: new Date().toISOString(),
    capabilities: FREE_TIER_CAPABILITIES,
    overrides: [],
    evaluationVersion: "1.0",
  };
}

// ── Deep merge utility ────────────────────────────────────────────────────────

function deepMergeCapabilities(base: CapabilitySet, overrides: CapabilityOverrides): CapabilitySet {
  const result = structuredClone(base);

  for (const groupKey of Object.keys(overrides) as Array<keyof CapabilitySet>) {
    const overrideGroup = overrides[groupKey];
    if (overrideGroup && typeof overrideGroup === "object") {
      const target = result[groupKey] as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(overrideGroup)) {
        if (v !== undefined) {
          target[k] = v;
        }
      }
    }
  }
  return result;
}

// ── Capability path resolution ────────────────────────────────────────────────

function resolveCapabilityValue(capabilities: CapabilitySet, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = capabilities;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Tier ordering (for upgrade prompts) ───────────────────────────────────────

function findRequiredTier(capability: string, db: DatabaseSync): CapabilityTierName {
  const tiers = repo.listTiers(db);
  for (const tier of tiers) {
    let caps: CapabilitySet;
    try {
      caps = JSON.parse(tier.capabilities) as CapabilitySet;
    } catch {
      continue;
    }
    const value = resolveCapabilityValue(caps, capability);
    if (
      value === true ||
      (typeof value === "number" && value > 0) ||
      (typeof value === "string" && value !== "")
    ) {
      return tier.name;
    }
  }
  return "enterprise";
}

// ── Evaluator class ───────────────────────────────────────────────────────────

const L1_TTL_MS = 30_000;
const L2_TTL_SECONDS = 300;
const REDIS_KEY_PREFIX = "cap:manifest:";

export class CapabilityFlagEvaluator {
  private l1Cache: Map<string, CacheEntry> = new Map();
  private lastGoodCache: Map<string, CapabilityManifest> = new Map();

  constructor(
    private db: DatabaseSync,
    private redis?: RedisClient,
  ) {}

  /**
   * Resolve the full capability manifest for a tenant.
   * Uses L1 → L2 → DB cascade with fail-safe fallback.
   */
  async resolve(tenantId: string): Promise<CapabilityManifest> {
    // L1 cache check
    const l1 = this.l1Cache.get(tenantId);
    if (l1 && l1.expiresAt > Date.now()) {
      return l1.manifest;
    }

    // L2 Redis cache check
    if (this.redis) {
      try {
        const cached = await this.redis.get(`${REDIS_KEY_PREFIX}${tenantId}`);
        if (cached) {
          const manifest = JSON.parse(cached) as CapabilityManifest;
          this.setL1(tenantId, manifest);
          this.lastGoodCache.set(tenantId, manifest);
          return manifest;
        }
      } catch (err) {
        log.warn(`L2 Redis cache read failed for tenant=${tenantId}: ${String(err)}`);
      }
    }

    // DB query
    try {
      const manifest = this.resolveFromDb(tenantId);
      this.setL1(tenantId, manifest);
      this.lastGoodCache.set(tenantId, manifest);

      // Populate L2
      if (this.redis) {
        this.redis
          .set(`${REDIS_KEY_PREFIX}${tenantId}`, JSON.stringify(manifest), {
            EX: L2_TTL_SECONDS,
          })
          .catch((err) => {
            log.warn(`L2 Redis cache write failed for tenant=${tenantId}: ${String(err)}`);
          });
      }

      return manifest;
    } catch (err) {
      // Fail-safe: use last good cached manifest
      const lastGood = this.lastGoodCache.get(tenantId);
      if (lastGood) {
        log.warn(
          `DB query failed for tenant=${tenantId}, using last cached manifest: ${String(err)}`,
        );
        return lastGood;
      }

      // No cache at all — return default free-tier manifest (fail-safe, NOT fail-open)
      log.error(
        `DB query failed for tenant=${tenantId}, no cached manifest available, defaulting to free tier: ${String(err)}`,
      );
      return createDefaultManifest(tenantId);
    }
  }

  /**
   * Check whether a tenant has a specific capability.
   */
  async check(tenantId: string, capability: string): Promise<CapabilityCheckResult> {
    const start = performance.now();
    const manifest = await this.resolve(tenantId);
    const value = resolveCapabilityValue(manifest.capabilities, capability);
    const elapsed = performance.now() - start;
    recordLatency(elapsed);

    const allowed =
      value === true ||
      (typeof value === "number" && value > 0) ||
      (typeof value === "string" && value !== "" && value !== "basic");

    if (allowed) {
      recordMetric(capability, manifest.tier, "allowed");
      return { allowed: true };
    }

    const requiredTier = findRequiredTier(capability, this.db);
    recordMetric(capability, manifest.tier, "denied");
    return {
      allowed: false,
      requiredTier,
      upgradeUrl: "/api/v1/tenant/upgrade",
    };
  }

  /**
   * Invalidate caches for a specific tenant.
   * Call after tier/override changes.
   */
  invalidate(tenantId: string): void {
    this.l1Cache.delete(tenantId);
    if (this.redis) {
      this.redis.del(`${REDIS_KEY_PREFIX}${tenantId}`).catch((err) => {
        log.warn(`L2 Redis cache invalidation failed for tenant=${tenantId}: ${String(err)}`);
      });
    }
  }

  /**
   * Invalidate all cached manifests for tenants on a given tier.
   * Call after tier definition changes.
   */
  invalidateByTier(_tierId: string): void {
    // Clear all L1 entries — we don't index by tier in L1, so clear all
    this.l1Cache.clear();
    // L2 is TTL-based and will naturally expire
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private resolveFromDb(tenantId: string): CapabilityManifest {
    const tenantCaps = repo.getTenantCapabilities(this.db, tenantId);

    if (!tenantCaps) {
      // No assignment — default to free tier
      return createDefaultManifest(tenantId);
    }

    const tier = repo.getTierById(this.db, tenantCaps.tierId);
    if (!tier) {
      log.warn(`Tier ${tenantCaps.tierId} not found for tenant=${tenantId}, defaulting to free`);
      return createDefaultManifest(tenantId);
    }

    let baseCaps: CapabilitySet;
    try {
      baseCaps = JSON.parse(tier.capabilities) as CapabilitySet;
    } catch {
      log.warn(`Invalid capabilities JSON for tier=${tier.id}, defaulting to free`);
      return createDefaultManifest(tenantId);
    }

    let overrides: CapabilityOverrides = {};
    let overrideKeys: string[] = [];
    try {
      const parsed = JSON.parse(tenantCaps.overrides) as Record<string, unknown>;
      overrides = parsed as CapabilityOverrides;
      overrideKeys = Object.keys(parsed);
    } catch {
      // Invalid override JSON — use base only
    }

    const mergedCaps =
      overrideKeys.length > 0 ? deepMergeCapabilities(baseCaps, overrides) : baseCaps;

    return {
      tenantId,
      tier: tier.name,
      resolvedAt: new Date().toISOString(),
      capabilities: mergedCaps,
      overrides: overrideKeys,
      evaluationVersion: "1.0",
    };
  }

  private setL1(tenantId: string, manifest: CapabilityManifest): void {
    this.l1Cache.set(tenantId, {
      manifest,
      expiresAt: Date.now() + L1_TTL_MS,
    });
  }
}
