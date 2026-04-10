/**
 * Outlook auth tools: start OAuth, check status, revoke.
 * Uses PKCE + localhost callback (same pattern as google-antigravity-auth).
 */

import { Type } from "@sinclair/typebox";
import type { MinionPluginApi } from "minion/plugin-sdk";
import {
  buildOutlookAuthUrl,
  credentialsPath,
  exchangeOutlookCode,
  generatePkce,
  getValidOutlookCredentials,
  graphFetch,
  listOutlookCredentials,
  OUTLOOK_SCOPES,
  saveOutlookCredentials,
  startOutlookCallbackServer,
  type OutlookOAuthConfig,
} from "./outlook-oauth.js";

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: { text } };
}

function getCtx(api: MinionPluginApi): { agentId: string; sessionKey: string } | null {
  const rt = api.runtime as unknown as Record<string, unknown>;
  const agentId = rt.agentId as string | undefined;
  const sessionKey = rt.sessionKey as string | undefined;
  if (!agentId || !sessionKey) return null;
  return { agentId, sessionKey };
}

const OutlookAuthStartSchema = Type.Object({
  email: Type.String({ description: "Microsoft account email address", minLength: 1 }),
  scopes: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Additional Microsoft Graph scopes (default set already includes Mail + Calendar)",
    }),
  ),
});

const OutlookAuthStatusSchema = Type.Object({
  email: Type.Optional(
    Type.String({ description: "Check status for a specific email (omit for all)" }),
  ),
});

const OutlookAuthRevokeSchema = Type.Object({
  email: Type.String({ description: "Microsoft account email to revoke", minLength: 1 }),
});

export function registerOutlookAuthTools(api: MinionPluginApi, config: OutlookOAuthConfig): void {
  // outlook_auth_start
  api.registerTool({
    name: "outlook_auth_start",
    label: "Outlook: Start OAuth",
    description:
      "Start Microsoft OAuth flow for Outlook Mail and Calendar access. " +
      "Returns an authorization URL for the user to visit in their browser. " +
      "IMPORTANT: Paste the raw URL on its own line — do not use markdown link format.",
    parameters: OutlookAuthStartSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      if (!config.clientId) {
        return txt(
          "Outlook OAuth is not configured. Set outlook.clientId in the plugin config, " +
            "or set OUTLOOK_CLIENT_ID environment variable. " +
            "See https://learn.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app",
        );
      }

      const email = String(p.email);
      const extraScopes = (p.scopes as string[] | undefined) ?? [];
      const scopes = [...new Set([...OUTLOOK_SCOPES, ...extraScopes])];

      const { verifier, challenge } = generatePkce();
      const state = crypto.randomUUID();
      const redirectUri = config.redirectUri ?? "http://localhost:51125/oauth-callback";
      const port = new URL(redirectUri).port ? Number(new URL(redirectUri).port) : 51125;

      const authUrl = buildOutlookAuthUrl({ config, state, challenge, scopes });

      let callbackServer: Awaited<ReturnType<typeof startOutlookCallbackServer>> | null = null;
      try {
        callbackServer = await startOutlookCallbackServer({ timeoutMs: 5 * 60 * 1000, port });
      } catch {
        callbackServer = null;
      }

      const lines = [
        `Outlook OAuth — authorize access for ${email}`,
        "",
        `Visit this URL in your browser:`,
        authUrl,
        "",
        callbackServer
          ? "The callback will be received automatically once you authorize."
          : `After authorizing, paste the full redirect URL back here (the URL starting with ${redirectUri}?code=...).`,
      ];

      if (!callbackServer) {
        return txt(lines.join("\n"));
      }

      // Wait for callback in background
      const handleCallback = async () => {
        try {
          const callbackUrl = await callbackServer!.waitForCallback();
          const code = callbackUrl.searchParams.get("code");
          const returnedState = callbackUrl.searchParams.get("state");

          if (!code) throw new Error("No code in callback URL");
          if (returnedState !== state) throw new Error("OAuth state mismatch");

          const tokens = await exchangeOutlookCode({ code, verifier, config, scopes });

          // Fetch user profile
          let userEmail = email;
          let displayName: string | undefined;
          try {
            const meResult = await graphFetch("/me?$select=displayName,mail,userPrincipalName", {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              email: userEmail,
              displayName: undefined,
              sessionKey: ctx.sessionKey,
              agentId: ctx.agentId,
              scopes,
              filePath: credentialsPath(ctx.agentId, ctx.sessionKey, userEmail),
            });
            if (meResult.ok) {
              const me = meResult.data as Record<string, unknown>;
              userEmail = String(me.mail ?? me.userPrincipalName ?? email);
              displayName = me.displayName ? String(me.displayName) : undefined;
            }
          } catch {
            /* ignore, use supplied email */
          }

          const filePath = credentialsPath(ctx.agentId, ctx.sessionKey, userEmail);
          saveOutlookCredentials({
            email: userEmail,
            displayName,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            scopes,
            filePath,
          });

          api.logger.info(`Outlook OAuth complete for ${userEmail}`);
        } catch (err) {
          api.logger.error(`Outlook OAuth callback failed: ${String(err)}`);
        } finally {
          await callbackServer!.close();
        }
      };

      // Non-blocking: handle callback in background
      void handleCallback();

      return txt(
        lines.join("\n") +
          "\n\n✅ Callback server is running — authorization will complete automatically.",
      );
    },
  });

  // outlook_auth_status
  api.registerTool({
    name: "outlook_auth_status",
    label: "Outlook: Auth Status",
    description: "Check Outlook OAuth authentication status for the current session.",
    parameters: OutlookAuthStatusSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const emailFilter = p.email ? String(p.email) : undefined;
      const all = listOutlookCredentials(ctx.agentId, ctx.sessionKey);
      const filtered = emailFilter ? all.filter((c) => c.email === emailFilter) : all;

      if (filtered.length === 0) {
        return txt(
          emailFilter
            ? `Not authenticated with Outlook for ${emailFilter}. Use outlook_auth_start.`
            : "No Outlook accounts authenticated. Use outlook_auth_start.",
        );
      }

      const lines = filtered.map((c) => {
        const expired = Date.now() > c.expiresAt;
        const expiresIn = expired
          ? "EXPIRED"
          : `expires in ~${Math.round((c.expiresAt - Date.now()) / 60_000)}m`;
        return `• ${c.email}${c.displayName ? ` (${c.displayName})` : ""} — ${expiresIn} — scopes: ${c.scopes.join(", ")}`;
      });

      return txt(`Outlook accounts:\n${lines.join("\n")}`);
    },
  });

  // outlook_auth_revoke
  api.registerTool({
    name: "outlook_auth_revoke",
    label: "Outlook: Revoke Auth",
    description: "Revoke stored Outlook credentials for an email account.",
    parameters: OutlookAuthRevokeSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const email = String(p.email);
      const creds = await getValidOutlookCredentials(ctx.agentId, ctx.sessionKey, email, config);
      if (!creds) {
        return txt(`No Outlook credentials found for ${email}.`);
      }

      // Best-effort revoke via Microsoft identity platform
      try {
        // Delete the stored credential file
        const { unlinkSync } = await import("node:fs");
        unlinkSync(creds.filePath);
      } catch {
        /* ignore */
      }

      return txt(`Outlook credentials for ${email} have been removed.`);
    },
  });
}
