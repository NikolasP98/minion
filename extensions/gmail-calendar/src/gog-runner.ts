/**
 * Shared helper for running gog CLI commands with credential injection.
 * Mirrors the logic in core gog_exec_tool.ts but scoped to this extension.
 */

import { buildGogEnvironment } from "../../../src/hooks/gog-command-exec.js";
import {
  getValidCredentials,
  importTokensToGogKeyring,
} from "../../../src/hooks/gog-credentials.js";
import { runCommandWithTimeout } from "../../../src/platform/process/exec.js";

export type GogContext = {
  agentId: string;
  sessionKey: string;
};

export type GogResult =
  | { ok: true; data: unknown }
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Parse a command string into argv respecting single/double quotes. */
function parseArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const DOUBLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"' };

  for (const char of command) {
    if (escaped) {
      current += inDouble ? (DOUBLE_ESCAPES[char] ?? `\\${char}`) : char;
      escaped = false;
      continue;
    }
    if (char === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) args.push(current);
  return args;
}

/**
 * Run a gog command (without the "gog" prefix) and return parsed JSON output.
 * Automatically injects account credentials.
 */
export async function runGog(
  command: string,
  ctx: GogContext,
  opts: { timeoutMs?: number; service?: string } = {},
): Promise<GogResult> {
  const { agentId, sessionKey } = ctx;
  const { timeoutMs = 60_000, service } = opts;

  // Credential check
  const credResult = await getValidCredentials(agentId, sessionKey);
  if (!credResult.credentials) {
    const msg = credResult.refreshFailed
      ? `Google token refresh failed: ${credResult.error}. Re-authenticate with gog_auth_start.`
      : "Not authenticated with Google. Use gog_auth_start first.";
    return { ok: false, error: msg };
  }
  const credentials = credResult.credentials;

  // Scope check
  if (service && !credentials.services.includes(service)) {
    const allServices = [...new Set([...credentials.services, service])];
    return {
      ok: false,
      error:
        `SCOPE MISSING: credentials for ${credentials.email} lack the "${service}" scope. ` +
        `Call gog_auth_start with services=[${allServices.map((s) => `"${s}"`).join(", ")}].`,
    };
  }

  // Build argv
  const argv = parseArgs(command);

  // Auto-inject --account
  if (!argv.includes("--account") && !argv.includes("-a")) {
    const svcIdx = argv.findIndex((a) =>
      ["gmail", "calendar", "drive", "contacts", "docs", "sheets", "auth"].includes(a),
    );
    if (svcIdx >= 0) argv.splice(svcIdx + 1, 0, "--account", credentials.email);
  }

  // Ensure --json
  if (!argv.includes("--json")) argv.push("--json");

  // Build environment and sync keyring
  const env = await buildGogEnvironment({ agentId, sessionKey, email: credentials.email });
  await importTokensToGogKeyring(credentials, env);

  // Execute
  const result = await runCommandWithTimeout(["gog", ...argv], { timeoutMs, env });

  if (result.killed || result.termination === "timeout") {
    return { ok: false, error: `Command timed out after ${timeoutMs / 1000}s` };
  }

  if (result.code !== 0) {
    const isScopeError = /insufficientPermissions|insufficient.*scopes?|403/i.test(result.stderr);
    const hint = isScopeError
      ? ` SCOPE ERROR: call gog_auth_start with email="${credentials.email}" to expand permissions.`
      : "";
    return {
      ok: false,
      error: `gog exited with code ${result.code}:${hint} ${result.stderr || result.stdout}`.trim(),
    };
  }

  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: true, text: result.stdout };
  }
}

/** Wrap a GogResult into the standard tool content format. */
export function gogResultToContent(result: GogResult): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  if (!result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
      details: { error: result.error },
    };
  }
  const payload = "data" in result ? result.data : result.text;
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}
