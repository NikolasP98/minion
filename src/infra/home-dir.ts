import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Standard home directory for the `node` user inside official node:* Docker images.
 * When the container runs as root (HOME=/root) without an explicit override, profile
 * data would land in /root/.minion — outside the mounted volume.  Redirecting to
 * this path ensures profiles survive container restarts.
 */
const DOCKER_HOME_ROOT = "/home/node";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Returns true when the process is running inside a Docker container.
 * Detection order:
 *   1. MINION_IN_DOCKER=1 env var (explicit override, useful in tests / exotic setups)
 *   2. Presence of /.dockerenv (standard Docker container marker)
 */
export function resolveIsInDocker(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (p: string) => boolean = fs.existsSync,
): boolean {
  if (env.MINION_IN_DOCKER === "1") {
    return true;
  }
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export const isInDocker = resolveIsInDocker();

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  existsSync: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const inDocker = resolveIsInDocker(env, existsSync);
  const raw = resolveRawHomeDir(env, homedir, inDocker);
  return raw ? path.resolve(raw) : undefined;
}

function resolveRawHomeDir(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  inDocker: boolean,
): string | undefined {
  const explicitHome = normalize(env.MINION_HOME);
  if (explicitHome) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      const fallbackHome =
        normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
      if (fallbackHome) {
        return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
      }
      return undefined;
    }
    return explicitHome;
  }

  const envHome = normalize(env.HOME);
  // When running inside Docker and HOME is absent or still set to /root (running
  // as root without an explicit HOME override), redirect to the standard node user
  // home so profile data lands on the mounted volume (/home/node/.minion) rather
  // than the ephemeral container root (/root/.minion).
  if (inDocker && (!envHome || envHome === "/root")) {
    return DOCKER_HOME_ROOT;
  }
  if (envHome) {
    return envHome;
  }

  const userProfile = normalize(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }

  return normalizeSafe(homedir);
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  existsSync: (p: string) => boolean = fs.existsSync,
): string {
  return resolveEffectiveHomeDir(env, homedir, existsSync) ?? path.resolve(process.cwd());
}

export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}
