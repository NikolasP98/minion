/**
 * Core types for the AudAgent Privacy Compliance Auditor.
 *
 * Implements EU AI Act Article 50 transparency and data-flow governance.
 * Reference: arXiv:2511.07441 "AudAgent: Automated Auditing of Privacy Policy Compliance in AI Agents"
 */

export type DataCategory =
  | "user_content" // message text, user input
  | "user_identity" // name, email, phone, user ID
  | "user_location" // GPS, IP, region
  | "message_history" // prior conversation context
  | "credentials" // tokens, API keys, passwords
  | "file_content" // uploaded files/documents
  | "metadata" // timestamps, session IDs (non-personal)
  | "tool_output" // responses from external tools
  | "health_info" // PHI: medical records, conditions, prescriptions, insurance IDs (HIPAA)
  | "financial_info"; // PCI: credit card numbers, bank accounts, SSN/TIN, transactions (PCI-DSS)

export type ConsentScope = "implicit" | "explicit" | "none";

export type ToolPrivacyDeclaration = {
  toolName: string;
  vendor: "anthropic" | "openai" | "third-party" | "local" | "unknown";
  dataCategories: DataCategory[];
  externalTransfer: boolean;
  retentionPolicy: "session-only" | "30-days" | "indefinite" | "unknown";
  gdprLegalBasis?: string; // e.g. "Art.6(1)(b) - contract performance"
};

export type AuditViolation = {
  type:
    | "undeclared_data_category"
    | "external_transfer_without_consent"
    | "policy_mismatch"
    | "unknown_tool";
  detail: string;
};

export type AuditEntry = {
  id: string; // crypto.randomUUID()
  timestamp: string; // ISO8601
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  params: Record<string, unknown>;
  paramCategories: DataCategory[];
  resultSummary?: string; // truncated, no raw PII
  resultCategories?: DataCategory[];
  durationMs?: number;
  error?: string;
  consentScope: ConsentScope;
  violations: AuditViolation[];
};
