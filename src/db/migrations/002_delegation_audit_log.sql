-- Migration 002: Delegation audit log for RFC 8693 `act` claim chains
-- MIN-543 — JWT delegation chain audit trail
--
-- Safe to run on fresh DB or existing DB (all statements use IF NOT EXISTS).
--
-- To roll back: DROP TABLE agent_delegation_audit_log;

-- ── Audit log table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_delegation_audit_log (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  chain_fingerprint TEXT NOT NULL,
  principal_depth  INTEGER NOT NULL,
  tool_scope       TEXT,
  raw_chain        TEXT NOT NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dal_tenant_id
  ON agent_delegation_audit_log(tenant_id);

CREATE INDEX IF NOT EXISTS idx_dal_created_at
  ON agent_delegation_audit_log(created_at);
