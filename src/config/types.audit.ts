/**
 * Audit configuration for the AudAgent Privacy Compliance Auditor.
 * EU AI Act Article 50 data-flow governance.
 */

export type AuditConfig = {
  /** Enable audit logging. When false, all audit hooks are no-ops. */
  enabled: boolean;
  /** Directory for audit log files. Default: ~/.minion/audit/ */
  dir?: string;
  /**
   * Block tool calls that would route sensitive user data to third-party
   * tools without appropriate consent. Default: false.
   */
  complianceGate?: boolean;
};
