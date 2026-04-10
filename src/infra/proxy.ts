import { spawnSync } from "node:child_process";

/**
 * Resolve a proxy URL for outbound HTTP(S) connections.
 *
 * Resolution order:
 * 1. `configProxy` — explicit value from per-account config (takes priority)
 * 2. Standard proxy environment variables: HTTPS_PROXY, HTTP_PROXY, ALL_PROXY
 *    (checked case-insensitively; HTTPS_PROXY wins over HTTP_PROXY over ALL_PROXY)
 * 3. macOS system proxy from `scutil --proxy` (only on darwin, only when no env var is set)
 *
 * Returns `undefined` when no proxy is configured anywhere.
 */
export function resolveProxyUrl(configProxy?: string): string | undefined {
  const explicit = configProxy?.trim();
  if (explicit) {
    return explicit;
  }

  const fromEnv = resolveProxyFromEnv();
  if (fromEnv) {
    return fromEnv;
  }

  if (process.platform === "darwin") {
    return resolveProxyFromScutil();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Env-var resolution
// ---------------------------------------------------------------------------

const ENV_VAR_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

function resolveProxyFromEnv(): string | undefined {
  for (const name of ENV_VAR_NAMES) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// macOS scutil --proxy resolution
// ---------------------------------------------------------------------------

/** Visible for testing. */
export function parseScutilProxyOutput(output: string): string | undefined {
  // Prefer HTTPS proxy first, fall back to HTTP proxy.
  // scutil --proxy output lines look like: `  HTTPSProxy : proxy.example.com`
  const proxyHost =
    extractScutilValue(output, "HTTPSProxy") ?? extractScutilValue(output, "HTTPProxy");
  if (!proxyHost) {
    return undefined;
  }

  const enableKey =
    proxyHost === extractScutilValue(output, "HTTPSProxy") ? "HTTPSEnable" : "HTTPEnable";
  const enabled = extractScutilValue(output, enableKey);
  // Enable flag is absent or "0" → proxy is configured but disabled; skip it.
  if (enabled !== undefined && enabled === "0") {
    return undefined;
  }

  const portKey = proxyHost === extractScutilValue(output, "HTTPSProxy") ? "HTTPSPort" : "HTTPPort";
  const port = extractScutilValue(output, portKey);

  return port ? `http://${proxyHost}:${port}` : `http://${proxyHost}`;
}

function extractScutilValue(output: string, key: string): string | undefined {
  // Lines in scutil --proxy output:   `    KeyName : value`
  const regex = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m");
  const match = regex.exec(output);
  return match ? match[1].trim() : undefined;
}

function resolveProxyFromScutil(): string | undefined {
  try {
    const res = spawnSync("scutil", ["--proxy"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (res.status !== 0 || !res.stdout) {
      return undefined;
    }
    return parseScutilProxyOutput(res.stdout);
  } catch {
    return undefined;
  }
}
