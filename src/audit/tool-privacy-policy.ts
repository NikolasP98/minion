/**
 * Built-in tool privacy declarations for AudAgent.
 *
 * Each known Minion tool is mapped to a ToolPrivacyDeclaration describing
 * which data categories it may touch, whether it transfers data externally,
 * and its retention policy.
 *
 * Unknown tools default to a conservative posture: vendor "unknown",
 * externalTransfer true, retentionPolicy "unknown".
 */

import type { DataCategory, ToolPrivacyDeclaration } from "./audit-types.js";

// Canonical declarations for known Minion tool names.
// Keys are lowercase tool names; aliases are listed under their canonical entry.
const KNOWN_TOOLS: Record<string, ToolPrivacyDeclaration> = {
  // Web / search
  web_search: {
    toolName: "web_search",
    vendor: "third-party",
    dataCategories: ["user_content", "message_history"],
    externalTransfer: true,
    retentionPolicy: "unknown",
    gdprLegalBasis: "Art.6(1)(b) - contract performance",
  },
  web_fetch: {
    toolName: "web_fetch",
    vendor: "third-party",
    dataCategories: ["user_content"],
    externalTransfer: true,
    retentionPolicy: "unknown",
  },
  browse_web: {
    toolName: "browse_web",
    vendor: "third-party",
    dataCategories: ["user_content", "message_history"],
    externalTransfer: true,
    retentionPolicy: "unknown",
  },

  // Shell / compute
  bash: {
    toolName: "bash",
    vendor: "local",
    dataCategories: ["file_content", "credentials"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },
  computer: {
    toolName: "computer",
    vendor: "local",
    dataCategories: ["file_content", "credentials", "user_content"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },
  execute_command: {
    toolName: "execute_command",
    vendor: "local",
    dataCategories: ["file_content", "credentials"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },

  // File operations
  read_file: {
    toolName: "read_file",
    vendor: "local",
    dataCategories: ["file_content"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },
  write_file: {
    toolName: "write_file",
    vendor: "local",
    dataCategories: ["file_content", "user_content"],
    externalTransfer: false,
    retentionPolicy: "indefinite",
  },
  list_files: {
    toolName: "list_files",
    vendor: "local",
    dataCategories: ["metadata"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },

  // Memory / knowledge
  memory_search: {
    toolName: "memory_search",
    vendor: "local",
    dataCategories: ["user_content", "message_history"],
    externalTransfer: false,
    retentionPolicy: "indefinite",
  },
  memory_store: {
    toolName: "memory_store",
    vendor: "local",
    dataCategories: ["user_content", "message_history", "user_identity"],
    externalTransfer: false,
    retentionPolicy: "indefinite",
  },

  // LLM / AI providers (external calls)
  llm_call: {
    toolName: "llm_call",
    vendor: "third-party",
    dataCategories: ["user_content", "message_history"],
    externalTransfer: true,
    retentionPolicy: "unknown",
    gdprLegalBasis: "Art.6(1)(b) - contract performance",
  },
  anthropic_messages: {
    toolName: "anthropic_messages",
    vendor: "anthropic",
    dataCategories: ["user_content", "message_history"],
    externalTransfer: true,
    retentionPolicy: "30-days",
    gdprLegalBasis: "Art.6(1)(b) - contract performance",
  },
  openai_chat: {
    toolName: "openai_chat",
    vendor: "openai",
    dataCategories: ["user_content", "message_history"],
    externalTransfer: true,
    retentionPolicy: "30-days",
    gdprLegalBasis: "Art.6(1)(b) - contract performance",
  },

  // Email / messaging
  send_email: {
    toolName: "send_email",
    vendor: "third-party",
    dataCategories: ["user_content", "user_identity"],
    externalTransfer: true,
    retentionPolicy: "unknown",
    gdprLegalBasis: "Art.6(1)(b) - contract performance",
  },
  send_message: {
    toolName: "send_message",
    vendor: "local",
    dataCategories: ["user_content", "user_identity"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },

  // Code execution sandbox
  code_interpreter: {
    toolName: "code_interpreter",
    vendor: "local",
    dataCategories: ["file_content", "user_content"],
    externalTransfer: false,
    retentionPolicy: "session-only",
  },
};

// Category coverage for unknown tools (conservative assumption)
const UNKNOWN_TOOL_CATEGORIES: DataCategory[] = ["user_content", "metadata"];

/**
 * Return the privacy declaration for a named tool.
 *
 * Falls back to a conservative unknown-tool declaration when the tool
 * is not in the built-in registry.
 */
export function getToolPrivacyDeclaration(toolName: string): ToolPrivacyDeclaration {
  const key = toolName.trim().toLowerCase();
  const known = KNOWN_TOOLS[key];
  if (known !== undefined) {
    return known;
  }

  // Conservative default for unrecognised tools
  return {
    toolName,
    vendor: "unknown",
    dataCategories: UNKNOWN_TOOL_CATEGORIES,
    externalTransfer: true, // conservative assumption
    retentionPolicy: "unknown",
  };
}

/**
 * List all tool names that have explicit privacy declarations.
 */
export function listDeclaredTools(): string[] {
  return Object.keys(KNOWN_TOOLS);
}
