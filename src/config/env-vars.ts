import type { MinionConfig } from "./types.js";

export function collectConfigEnvVars(cfg?: MinionConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [key, value] of Object.entries(envConfig.vars)) {
      if (!value) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (key === "shellEnv" || key === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

export function applyConfigEnvVars(cfg: MinionConfig, env: NodeJS.ProcessEnv = process.env): void {
  const entries = collectConfigEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) {
      continue;
    }
    env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Canonical environment variable resolution with legacy alias support.
//
// The codebase historically used multiple prefixes for the same env vars:
//   MINION_*, OPENCLAW_*, CLAWDBOT_*, MINIONBOT_*
//
// Resolution order (highest priority first):
//   MINION_* > OPENCLAW_* > CLAWDBOT_* > MINIONBOT_*
//
// EXCEPTION: src/platform/daemon/paths.ts uses OPENCLAW_* > MINION_* for
// backward compat with existing daemon installations. See that file's header.
//
// Known env var suffixes and their purposes:
//   STATE_DIR         — Root state/config directory (~/.minion)
//   GATEWAY_PORT      — WebSocket gateway port (default 18789)
//   GATEWAY_TOKEN     — Authentication token for gateway
//   GATEWAY_PASSWORD  — Password for gateway access
//   HOME              — Override home directory
// ---------------------------------------------------------------------------

const PREFIXES = ["MINION", "OPENCLAW", "CLAWDBOT", "MINIONBOT"] as const;

/**
 * Resolve an env var by suffix, checking all known prefixes in priority order.
 * Returns the first non-empty trimmed value, or undefined.
 *
 * @example
 *   resolveEnvVar("GATEWAY_PORT") // checks MINION_GATEWAY_PORT, OPENCLAW_GATEWAY_PORT, etc.
 */
export function resolveEnvVar(
  suffix: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const prefix of PREFIXES) {
    const val = env[`${prefix}_${suffix}`]?.trim();
    if (val) {
      return val;
    }
  }
  return undefined;
}

/**
 * Resolve an env var as an integer, with fallback.
 */
export function resolveEnvInt(
  suffix: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = resolveEnvVar(suffix, env);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve an env var as a boolean.
 * Truthy: "1", "true", "yes" (case-insensitive).
 */
export function resolveEnvBool(
  suffix: string,
  fallback: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = resolveEnvVar(suffix, env);
  if (raw === undefined) {
    return fallback;
  }
  return ["1", "true", "yes"].includes(raw.toLowerCase());
}
