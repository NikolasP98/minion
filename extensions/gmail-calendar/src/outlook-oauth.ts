/**
 * Microsoft Graph OAuth for Outlook Mail + Calendar.
 *
 * PKCE + localhost callback server flow, following the same pattern as
 * google-antigravity-auth and notion-auth extensions.
 *
 * Credentials are stored per-session at:
 *   ~/.minion/agents/<agentId>/auth-credentials/outlook/<sessionKey>_<email>.json
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";

const log = createSubsystemLogger("outlook-oauth");

// Microsoft Graph OAuth endpoints
const AUTH_URL = "https://login.microsoftonline.com";
const GRAPH_URL = "https://graph.microsoft.com/v1.0";

// Default scopes for Outlook Mail + Calendar
export const OUTLOOK_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.Read",
  "Calendars.Read",
  "Calendars.ReadWrite",
];

export type OutlookCredentials = {
  email: string;
  displayName?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sessionKey: string;
  agentId: string;
  scopes: string[];
  filePath: string;
};

export type OutlookOAuthConfig = {
  clientId: string;
  clientSecret?: string;
  tenantId?: string;
  redirectUri?: string;
};

// ── PKCE ─────────────────────────────────────────────────────────────

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Credential storage ────────────────────────────────────────────────

function credentialsDir(agentId: string): string {
  return path.join(os.homedir(), ".minion", "agents", agentId, "auth-credentials", "outlook");
}

function credentialsPath(agentId: string, sessionKey: string, email: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, "_");
  return path.join(credentialsDir(agentId), `${safe(sessionKey)}_${safe(email)}.json`);
}

export function saveOutlookCredentials(creds: OutlookCredentials): void {
  const dir = credentialsDir(creds.agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(creds.filePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function loadOutlookCredentials(
  agentId: string,
  sessionKey: string,
  email: string,
): OutlookCredentials | null {
  const p = credentialsPath(agentId, sessionKey, email);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as OutlookCredentials;
  } catch {
    return null;
  }
}

export function listOutlookCredentials(agentId: string, sessionKey: string): OutlookCredentials[] {
  const dir = credentialsDir(agentId);
  if (!existsSync(dir)) return [];
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, "_");
  const prefix = `${safe(sessionKey)}_`;
  try {
    const files = readdirSync(dir);
    return files
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as OutlookCredentials];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ── Token refresh ─────────────────────────────────────────────────────

export async function refreshOutlookToken(
  creds: OutlookCredentials,
  config: OutlookOAuthConfig,
): Promise<OutlookCredentials> {
  const tenantId = config.tenantId ?? "common";
  const tokenUrl = `${AUTH_URL}/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    scope: creds.scopes.join(" "),
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Outlook token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const refreshed: OutlookCredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
  saveOutlookCredentials(refreshed);
  return refreshed;
}

/** Get valid (auto-refreshed if needed) Outlook credentials for a session. */
export async function getValidOutlookCredentials(
  agentId: string,
  sessionKey: string,
  email: string,
  config: OutlookOAuthConfig,
): Promise<OutlookCredentials | null> {
  const creds = loadOutlookCredentials(agentId, sessionKey, email);
  if (!creds) return null;
  if (Date.now() < creds.expiresAt) return creds;

  try {
    return await refreshOutlookToken(creds, config);
  } catch (err) {
    log.warn(`Token refresh failed for ${email}: ${String(err)}`);
    return null;
  }
}

// ── Auth URL builder ──────────────────────────────────────────────────

export function buildOutlookAuthUrl(opts: {
  config: OutlookOAuthConfig;
  state: string;
  challenge: string;
  scopes?: string[];
}): string {
  const tenantId = opts.config.tenantId ?? "common";
  const redirectUri = opts.config.redirectUri ?? "http://localhost:51125/oauth-callback";
  const scopes = opts.scopes ?? OUTLOOK_SCOPES;

  const url = new URL(`${AUTH_URL}/${tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", opts.config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

// ── Callback server ───────────────────────────────────────────────────

const RESPONSE_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Minion Outlook OAuth</title></head>
<body><main><h1>Authentication complete</h1><p>You can return to the terminal.</p></main></body></html>`;

export async function startOutlookCallbackServer(params: { timeoutMs: number; port: number }) {
  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (err: Error) => void;

  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    rejectCallback = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
  });

  const timeout = setTimeout(
    () => rejectCallback(new Error("Timed out waiting for Outlook OAuth callback")),
    params.timeoutMs,
  );
  timeout.unref?.();

  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end("Missing URL");
      return;
    }
    const url = new URL(req.url, `http://localhost:${params.port}`);
    if (url.pathname !== "/oauth-callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(RESPONSE_PAGE);
    resolveCallback(url);
    setImmediate(() => server.close());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(params.port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Token exchange ────────────────────────────────────────────────────

export async function exchangeOutlookCode(opts: {
  code: string;
  verifier: string;
  config: OutlookOAuthConfig;
  scopes: string[];
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const tenantId = opts.config.tenantId ?? "common";
  const redirectUri = opts.config.redirectUri ?? "http://localhost:51125/oauth-callback";
  const tokenUrl = `${AUTH_URL}/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: opts.config.clientId,
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: redirectUri,
    code_verifier: opts.verifier,
    scope: opts.scopes.join(" "),
  });
  if (opts.config.clientSecret) body.set("client_secret", opts.config.clientSecret);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Outlook token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!data.access_token) throw new Error("No access_token in Outlook token response");
  if (!data.refresh_token)
    throw new Error("No refresh_token — ensure offline_access scope is requested");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// ── Microsoft Graph fetch helper ──────────────────────────────────────

export async function graphFetch(
  endpoint: string,
  creds: OutlookCredentials,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = endpoint.startsWith("https://") ? endpoint : `${GRAPH_URL}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (response.status === 204) return { ok: true, data: { success: true } };

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const errMsg =
      typeof data === "object" && data !== null
        ? (((data as Record<string, unknown>).error as Record<string, unknown>)?.message ?? text)
        : text;
    return { ok: false, error: `Graph API error ${response.status}: ${String(errMsg)}` };
  }

  return { ok: true, data };
}

export { generatePkce, credentialsPath };
