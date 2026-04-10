-- Migration 003: Capability tier / feature-flag system
-- MIN-458 — SaaS tier differentiation infrastructure
--
-- Safe to run on fresh DB or existing DB (all statements use IF NOT EXISTS).
-- Does NOT modify existing tables.
--
-- To roll back: DROP TABLE capability_audit_log;
--               DROP TABLE tenant_capabilities;
--               DROP TABLE capability_tiers;

-- ── Tier definitions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS capability_tiers (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE CHECK(name IN ('free', 'pro', 'enterprise')),
  capabilities TEXT    NOT NULL DEFAULT '{}',  -- JSON blob (CapabilityManifest.capabilities)
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,               -- ISO-8601
  updated_at   TEXT    NOT NULL                -- ISO-8601
);

-- ── Per-tenant tier assignment + overrides ────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_capabilities (
  id           TEXT    PRIMARY KEY,
  tenant_id    TEXT    NOT NULL UNIQUE,
  tier_id      TEXT    NOT NULL REFERENCES capability_tiers(id),
  overrides    TEXT    NOT NULL DEFAULT '{}',   -- JSON blob
  effective_at TEXT    NOT NULL,                -- ISO-8601
  changed_by   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_capabilities_tenant_id
  ON tenant_capabilities(tenant_id);

-- ── Immutable audit log ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS capability_audit_log (
  id            TEXT    PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  changed_at    TEXT    NOT NULL,               -- ISO-8601
  old_tier      TEXT,
  new_tier      TEXT,
  changed_by    TEXT    NOT NULL,
  override_diff TEXT                            -- JSON patch or null
);

CREATE INDEX IF NOT EXISTS idx_capability_audit_log_tenant_id
  ON capability_audit_log(tenant_id);

CREATE INDEX IF NOT EXISTS idx_capability_audit_log_changed_at
  ON capability_audit_log(changed_at);
