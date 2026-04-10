/**
 * MINION Gmail + Calendar module plugin.
 *
 * Provides:
 * - 18+ Gmail tools (list, read, search, send, reply, label, categorize, draft, approval gate)
 * - 10 Google Calendar tools (list, get, create, update, delete, search, rsvp, free-slots)
 * - 3 Outlook Auth tools (start OAuth, status, revoke)
 * - 22 Outlook Mail tools (list, read, search, send, reply, forward, move, flag, categorize, etc.)
 * - 9 Outlook Calendar tools (list, get, create, update, delete, rsvp, free-busy, search)
 * - Shared approval gate: email_send_confirm, email_send_cancel, email_send_pending
 *
 * Configuration (minion.json or plugin config):
 *   gmail_calendar.requireApproval  — human gate before sends (default: true)
 *   gmail_calendar.outlook.clientId — Azure app client ID for Outlook OAuth
 *   gmail_calendar.outlook.clientSecret — Azure app client secret (optional for PKCE)
 *   gmail_calendar.outlook.tenantId — Azure tenant ID (default: "common")
 *   gmail_calendar.outlook.redirectUri — OAuth callback URI (default: http://localhost:51125/oauth-callback)
 */

import type { MinionPluginApi } from "minion/plugin-sdk";
import { registerCalendarTools } from "./src/calendar-tools.js";
import { registerGmailTools } from "./src/gmail-tools.js";
import { registerOutlookAuthTools } from "./src/outlook-auth-tool.js";
import { registerOutlookCalendarTools } from "./src/outlook-calendar-tools.js";
import { registerOutlookMailTools } from "./src/outlook-mail-tools.js";
import type { OutlookOAuthConfig } from "./src/outlook-oauth.js";

type PluginConfig = {
  requireApproval?: boolean;
  approvalTimeoutMs?: number;
  outlook?: {
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
    redirectUri?: string;
  };
};

const plugin = {
  id: "gmail-calendar",
  name: "Gmail + Calendar",
  description:
    "MINION agentic email + calendar toolkit. " +
    "Provides Gmail, Google Calendar, Outlook Mail, and Outlook Calendar tools " +
    "with OAuth, approval gates, and smart categorization.",

  register(api: MinionPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    const requireApproval = cfg.requireApproval !== false; // default: true
    const outlookConfig: OutlookOAuthConfig = {
      clientId: cfg.outlook?.clientId ?? process.env.OUTLOOK_CLIENT_ID ?? "",
      clientSecret: cfg.outlook?.clientSecret ?? process.env.OUTLOOK_CLIENT_SECRET,
      tenantId: cfg.outlook?.tenantId ?? process.env.OUTLOOK_TENANT_ID,
      redirectUri:
        cfg.outlook?.redirectUri ??
        process.env.OUTLOOK_REDIRECT_URI ??
        "http://localhost:51125/oauth-callback",
    };

    // Google (Gmail + Calendar) — reuses existing gog_auth_start infrastructure
    registerGmailTools(api, requireApproval);
    registerCalendarTools(api, requireApproval);

    // Outlook (Mail + Calendar) — own OAuth via Microsoft Graph
    registerOutlookAuthTools(api, outlookConfig);
    registerOutlookMailTools(api, outlookConfig, requireApproval);
    registerOutlookCalendarTools(api, outlookConfig, requireApproval);

    api.logger.info(
      `gmail-calendar loaded — requireApproval=${requireApproval}, outlook=${!!outlookConfig.clientId}`,
    );
  },
};

export default plugin;
