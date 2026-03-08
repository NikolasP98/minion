/**
 * Google OAuth provider implementation.
 * Implements the AuthProvider interface for Google OAuth flows.
 *
 * Extracts Google-specific logic (URL building, token exchange, scope mapping,
 * credential storage) behind the provider abstraction so future providers
 * (Microsoft, GitHub) can implement the same interface.
 */

import fs from "fs/promises";
import path from "path";
import {
  buildCredentialFilename,
  getCredentialsDir,
  getGoogleClientId,
  getGoogleClientSecret,
  getLegacyCredentialsDir,
  syncToGogKeyring,
} from "../../hooks/gog-credentials.js";
import { GOOGLE_SERVICE_SCOPES, getScopesForServices } from "../../hooks/gog-oauth-types.js";
import type { GogCredentials } from "../../hooks/gog-oauth-types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  AuthProvider,
  AuthUrlParams,
  StoreCredentialsParams,
  StoredCredentials,
  TokenResponse,
} from "../provider.js";

const log = createSubsystemLogger("google-auth-provider");

// ── Credential path helpers ──────────────────────────────────────────
// Canonical implementations live in gog-credentials.ts; re-export alias for test compat.
export { getCredentialsDir as getProviderCredentialsDir };

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a Google OAuth provider instance.
 * Uses factory function pattern per codebase convention.
 */
export function createGoogleAuthProvider(): AuthProvider {
  return {
    id: "google",
    displayName: "Google",

    buildAuthUrl(params: AuthUrlParams): string {
      const clientId = getGoogleClientId();
      const scopes = getScopesForServices(params.services);

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", params.redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes.join(" "));
      authUrl.searchParams.set("state", params.state);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("login_hint", params.email);

      return authUrl.toString();
    },

    async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
      const clientId = getGoogleClientId();
      const clientSecret = getGoogleClientSecret();

      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed (${response.status}): ${error}`);
      }

      return (await response.json()) as TokenResponse;
    },

    getScopesForServices(services: string[]): string[] {
      return getScopesForServices(services);
    },

    getSupportedServices(): string[] {
      return Object.keys(GOOGLE_SERVICE_SCOPES);
    },

    async storeCredentials(params: StoreCredentialsParams): Promise<string> {
      const dir = getCredentialsDir(params.agentId);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });

      const filename = buildCredentialFilename(params.sessionKey, params.email);
      const credPath = path.join(dir, filename);

      const credentials: GogCredentials = {
        email: params.email,
        accessToken: params.tokens.access_token,
        refreshToken: params.tokens.refresh_token ?? "",
        expiresAt: Date.now() + params.tokens.expires_in * 1000,
        createdAt: Date.now(),
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        services: params.services,
        filePath: credPath,
      };

      await fs.writeFile(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

      // Best-effort sync to gog CLI keyring
      await syncToGogKeyring(credentials);

      return credPath;
    },

    async loadCredentials(
      agentId: string,
      sessionKey: string,
      email: string,
    ): Promise<StoredCredentials | null> {
      const filename = buildCredentialFilename(sessionKey, email);

      // 1. Check new path first
      const newDir = getCredentialsDir(agentId);
      const newPath = path.join(newDir, filename);

      try {
        const data = await fs.readFile(newPath, "utf-8");
        const creds: GogCredentials = JSON.parse(data);
        creds.filePath = newPath;
        return creds;
      } catch {
        // Not found at new path, check legacy
      }

      // 2. Check legacy gog-credentials/ path and migrate if found
      const oldDir = getLegacyCredentialsDir(agentId);
      const oldPath = path.join(oldDir, filename);

      try {
        const data = await fs.readFile(oldPath, "utf-8");
        const creds: GogCredentials = JSON.parse(data);

        // Migrate: copy to new path, then delete old file
        log.info(
          `Migrating credentials from gog-credentials/ to auth-credentials/google/ for ${email}`,
        );

        await fs.mkdir(newDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(newPath, data, { mode: 0o600 });

        // Verify the copy succeeded before deleting
        try {
          await fs.access(newPath);
          await fs.unlink(oldPath);
          log.info(`Migration complete: deleted legacy credential at ${oldPath}`);
        } catch {
          log.warn(`Migration: new file written but could not delete old file at ${oldPath}`);
        }

        creds.filePath = newPath;
        return creds;
      } catch {
        // Not found at legacy path either
      }

      return null;
    },
  };
}
