/**
 * Secure permission enforcement for auth profile files.
 *
 * Auth profile directories must be 0700 (owner-only) and auth-profiles.json
 * must be 0600. New writes via saveJsonFile already apply these modes.
 * This module handles existing files that may have been created with looser
 * permissions by older versions.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveStateDir } from "../../config/paths.js";
import { AUTH_PROFILE_FILENAME } from "./constants.js";

const log = createSubsystemLogger("auth/permissions");

/** Required directory permission mode (owner read+write+execute only). */
const DIR_MODE = 0o700;
/** Required file permission mode (owner read+write only). */
const FILE_MODE = 0o600;

/**
 * Enforce secure permissions on a single auth profile path.
 *
 * - The directory containing the auth profile is set to 0700.
 * - The auth-profiles.json file (if it exists) is set to 0600.
 *
 * Errors are logged and swallowed — a permission fix failure must never
 * prevent the gateway from starting.
 */
export function enforceAuthProfilePermissions(agentDir: string): void {
  // Enforce directory permissions
  try {
    fs.chmodSync(agentDir, DIR_MODE);
  } catch (err) {
    log.warn("could not chmod agent dir", { agentDir, err: String(err) });
  }

  // Enforce auth-profiles.json permissions
  const profilesPath = path.join(agentDir, AUTH_PROFILE_FILENAME);
  try {
    if (fs.existsSync(profilesPath)) {
      fs.chmodSync(profilesPath, FILE_MODE);
    }
  } catch (err) {
    log.warn("could not chmod auth-profiles.json", { profilesPath, err: String(err) });
  }
}

/**
 * Recursively enforce secure permissions across all known auth profile
 * directories under the Minion state directory.
 *
 * Scans `<stateDir>/agents/<id>/agent/` for all agent subdirectories.
 * Also handles the main agent dir at the default path.
 *
 * Call once at gateway startup to harden any files created by older versions.
 */
export function enforceAllAuthProfilePermissions(): void {
  const stateDir = resolveStateDir(process.env);
  const agentsRoot = path.join(stateDir, "agents");

  // Collect all agent subdirectories
  const agentDirs: string[] = [];

  try {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      // Agent dirs follow the pattern: <agentsRoot>/<agentId>/agent
      const agentSubdir = path.join(agentsRoot, entry.name, "agent");
      if (fs.existsSync(agentSubdir)) {
        agentDirs.push(agentSubdir);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("could not scan agents directory", { agentsRoot, err: String(err) });
    }
  }

  if (agentDirs.length === 0) {
    return;
  }

  let fixed = 0;
  for (const agentDir of agentDirs) {
    enforceAuthProfilePermissions(agentDir);
    fixed++;
  }

  if (fixed > 0) {
    log.info("enforced auth profile permissions", { agentCount: fixed });
  }
}
