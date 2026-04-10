/**
 * Capability manifest types — capability-tier / feature-flag system.
 *
 * MIN-458 — SaaS tier differentiation infrastructure.
 *
 * @module
 */

// ── Tier names ────────────────────────────────────────────────────────────────

export type CapabilityTierName = "free" | "pro" | "enterprise";

// ── Capability manifest shape ─────────────────────────────────────────────────

export interface ChannelCapabilities {
  slack: boolean;
  teams: boolean;
  email: boolean;
  api: boolean;
  webhook: boolean;
}

export interface ModelCapabilities {
  tier: "basic" | "standard" | "advanced";
  allowedModels: string[];
  maxContextWindow: number;
}

export interface RateLimitCapabilities {
  requestsPerMinute: number;
  agentsPerWorkspace: number;
  tasksPerDay: number;
}

export interface FeatureCapabilities {
  customAgentPersonas: boolean;
  advancedAnalytics: boolean;
  apiAccess: boolean;
  ssoIntegration: boolean;
  auditLogs: boolean;
  prioritySupport: boolean;
  whiteLabel: boolean;
  dataExport: boolean;
}

export interface IntegrationCapabilities {
  github: boolean;
  linear: boolean;
  jira: boolean;
  salesforce: boolean;
}

export interface CapabilitySet {
  channels: ChannelCapabilities;
  models: ModelCapabilities;
  rateLimits: RateLimitCapabilities;
  features: FeatureCapabilities;
  integrations: IntegrationCapabilities;
}

export interface CapabilityManifest {
  tenantId: string;
  tier: CapabilityTierName;
  resolvedAt: string;
  capabilities: CapabilitySet;
  overrides: string[];
  evaluationVersion: string;
}

// ── Overrides ─────────────────────────────────────────────────────────────────

export type CapabilityOverrides = {
  [K in keyof CapabilitySet]?: Partial<CapabilitySet[K]>;
};

// ── Check result ──────────────────────────────────────────────────────────────

export type CapabilityCheckResult =
  | { allowed: true }
  | { allowed: false; requiredTier: CapabilityTierName; upgradeUrl: string };

// ── Error constant ────────────────────────────────────────────────────────────

export const CAPABILITY_ERROR_CODE = "capability_required" as const;

// ── DB row types ──────────────────────────────────────────────────────────────

export interface TierRow {
  id: string;
  name: CapabilityTierName;
  capabilities: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TenantCapabilitiesRow {
  id: string;
  tenantId: string;
  tierId: string;
  overrides: string;
  effectiveAt: string;
  changedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogRow {
  id: string;
  tenantId: string;
  changedAt: string;
  oldTier: string | null;
  newTier: string | null;
  changedBy: string;
  overrideDiff: string | null;
}
