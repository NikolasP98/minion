/**
 * Static tool dispatch registry with per-tool metadata.
 *
 * Central registry where each tool declares: name, description, riskTier,
 * rateLimit config, and required capabilities. Single source of truth for
 * S7 tool rate limits and S6 command risk classification.
 *
 * Inspired by NullClaw's comptime dispatch table and IronClaw's
 * WASM capability system.
 */

import type { RiskLevel } from "../security/command-risk.js";
import { normalizeToolName } from "./normalize-tool-name.js";
import type { RateLimitConfig } from "./rate-limiter.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ToolMetadata {
  /** Tool name (canonical, lowercase, underscored). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Risk tier for autonomy enforcement. */
  riskTier: RiskLevel;
  /** Optional per-tool rate limit config. */
  rateLimit?: RateLimitConfig;
  /** Required capabilities (for future WASM capability gating). */
  capabilities?: string[];
  /** Tool category for grouping in UI/docs. */
  category: ToolCategory;
  /** Whether this tool is dangerous for sub-agents. */
  dangerousForSubagents?: boolean;
}

export type ToolCategory =
  | "filesystem"
  | "execution"
  | "search"
  | "memory"
  | "communication"
  | "browser"
  | "system"
  | "scheduling";

// ── Registry ─────────────────────────────────────────────────────────

const registry = new Map<string, ToolMetadata>();

/**
 * Register a tool with metadata.
 */
export function registerTool(meta: ToolMetadata): void {
  registry.set(normalizeToolName(meta.name), meta);
}

/**
 * Get metadata for a tool by name.
 */
export function getToolMetadata(name: string): ToolMetadata | undefined {
  return registry.get(normalizeToolName(name));
}

/**
 * Get the risk tier for a tool. Returns "medium" for unknown tools.
 */
export function getToolRiskTier(name: string): RiskLevel {
  return getToolMetadata(name)?.riskTier ?? "medium";
}

/**
 * Get the rate limit config for a tool. Returns undefined if no limit.
 */
export function getToolRateLimit(name: string): RateLimitConfig | undefined {
  return getToolMetadata(name)?.rateLimit;
}

/**
 * List all registered tools, optionally filtered by category.
 */
export function listRegisteredTools(category?: ToolCategory): ToolMetadata[] {
  const all = [...registry.values()];
  return category ? all.filter((t) => t.category === category) : all;
}

/**
 * Check if a tool is registered.
 */
export function isToolRegistered(name: string): boolean {
  return registry.has(normalizeToolName(name));
}

/**
 * Clear all registrations (for testing).
 */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * Get count of registered tools.
 */
export function registeredToolCount(): number {
  return registry.size;
}

// ── Built-in tool registrations ──────────────────────────────────────

/** Register all built-in tools with their default metadata. */
export function registerBuiltinTools(): void {
  const builtins: ToolMetadata[] = [
    // Filesystem — low risk
    { name: "read", description: "Read file contents", riskTier: "low", category: "filesystem" },
    {
      name: "grep",
      description: "Search file contents for patterns",
      riskTier: "low",
      category: "search",
    },
    {
      name: "find",
      description: "Find files by glob pattern",
      riskTier: "low",
      category: "search",
    },
    { name: "ls", description: "List directory contents", riskTier: "low", category: "filesystem" },

    // Filesystem — medium risk (mutating)
    {
      name: "write",
      description: "Create or overwrite files",
      riskTier: "medium",
      category: "filesystem",
    },
    {
      name: "edit",
      description: "Make precise edits to files",
      riskTier: "medium",
      category: "filesystem",
    },
    {
      name: "apply_patch",
      description: "Apply multi-file patches",
      riskTier: "medium",
      category: "filesystem",
    },

    // Execution — high risk
    {
      name: "exec",
      description: "Run shell commands",
      riskTier: "high",
      category: "execution",
      dangerousForSubagents: true,
    },

    // Memory — low risk
    {
      name: "memory_search",
      description: "Search memory index",
      riskTier: "low",
      category: "memory",
    },
    {
      name: "memory_get",
      description: "Get memory lines by path",
      riskTier: "low",
      category: "memory",
    },

    // Web — medium risk (network access)
    {
      name: "web_search",
      description: "Search the web",
      riskTier: "medium",
      category: "search",
      rateLimit: { maxCalls: 20, windowSecs: 60 },
    },
    {
      name: "web_fetch",
      description: "Fetch URL content",
      riskTier: "medium",
      category: "search",
      rateLimit: { maxCalls: 30, windowSecs: 60 },
    },

    // Browser — medium risk
    {
      name: "browser",
      description: "Control web browser",
      riskTier: "medium",
      category: "browser",
    },

    // Communication — medium risk
    {
      name: "message",
      description: "Send messages and channel actions",
      riskTier: "medium",
      category: "communication",
      rateLimit: { maxCalls: 10, windowSecs: 60 },
    },

    // System — high risk
    {
      name: "gateway",
      description: "Restart/configure gateway",
      riskTier: "high",
      category: "system",
      dangerousForSubagents: true,
    },
    {
      name: "sessions_spawn",
      description: "Spawn sub-agent sessions",
      riskTier: "high",
      category: "system",
      dangerousForSubagents: true,
    },
    {
      name: "sessions_send",
      description: "Send messages to other sessions",
      riskTier: "high",
      category: "system",
      dangerousForSubagents: true,
    },

    // Scheduling — medium risk
    { name: "cron", description: "Manage cron jobs", riskTier: "medium", category: "scheduling" },

    // Canvas
    {
      name: "canvas",
      description: "Present/eval/snapshot Canvas",
      riskTier: "low",
      category: "browser",
    },
  ];

  for (const tool of builtins) {
    registerTool(tool);
  }
}
