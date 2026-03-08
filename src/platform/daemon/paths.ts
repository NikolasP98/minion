/**
 * Lightweight path resolution for daemon/service contexts (systemd, launchd, schtasks).
 *
 * INTENTIONAL DIVERGENCE from src/infra/home-dir.ts and src/utils.ts:
 * This module must remain self-contained (no imports outside platform/daemon/)
 * because it runs in constrained environments during service installation.
 *
 * Env var precedence here: OPENCLAW_STATE_DIR > MINION_STATE_DIR (legacy compat
 * for existing daemon installations). The main-app resolveConfigDir in src/utils.ts
 * uses MINION_STATE_DIR > OPENCLAW_STATE_DIR (forward-looking).
 */
import path from "node:path";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

export function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

export function resolveUserPathWithHome(input: string, home?: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    if (!home) {
      throw new Error("Missing HOME");
    }
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = (env.OPENCLAW_STATE_DIR ?? env.MINION_STATE_DIR)?.trim();
  if (override) {
    const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveHomeDir(env);
  const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE ?? env.MINION_PROFILE);
  return path.join(home, `.minion${suffix}`);
}
