/**
 * Outlook Mail tools for the MINION email + calendar module.
 *
 * 20+ tools wrapping the Microsoft Graph Mail API.
 * Authentication handled by outlook-oauth.ts credential store.
 */

import { Type } from "@sinclair/typebox";
import type { MinionPluginApi } from "minion/plugin-sdk";
import { buildApprovalPrompt, createPending } from "./approval-gate.js";
import {
  getValidOutlookCredentials,
  graphFetch,
  type OutlookCredentials,
  type OutlookOAuthConfig,
} from "./outlook-oauth.js";

// ── Helpers ───────────────────────────────────────────────────────────

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: { text } };
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function getCtx(api: MinionPluginApi): { agentId: string; sessionKey: string } | null {
  const rt = api.runtime as unknown as Record<string, unknown>;
  const agentId = rt.agentId as string | undefined;
  const sessionKey = rt.sessionKey as string | undefined;
  if (!agentId || !sessionKey) return null;
  return { agentId, sessionKey };
}

async function getOutlookCreds(
  api: MinionPluginApi,
  email: string,
  config: OutlookOAuthConfig,
): Promise<OutlookCredentials | { error: string }> {
  const ctx = getCtx(api);
  if (!ctx) return { error: "Missing agent context." };
  const creds = await getValidOutlookCredentials(ctx.agentId, ctx.sessionKey, email, config);
  if (!creds) {
    return {
      error: `Not authenticated with Outlook for ${email}. Use outlook_auth_start first.`,
    };
  }
  return creds;
}

/** Build a minimal Graph message payload for sending. */
function buildMessagePayload(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  isHtml?: boolean;
}): Record<string, unknown> {
  const toRecipients = opts.to
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => ({ emailAddress: { address: e } }));

  const ccRecipients = opts.cc
    ? opts.cc.split(",").map((e) => ({ emailAddress: { address: e.trim() } }))
    : undefined;

  const bccRecipients = opts.bcc
    ? opts.bcc.split(",").map((e) => ({ emailAddress: { address: e.trim() } }))
    : undefined;

  return {
    message: {
      subject: opts.subject,
      body: {
        contentType: opts.isHtml ? "HTML" : "Text",
        content: opts.body,
      },
      toRecipients,
      ...(ccRecipients && { ccRecipients }),
      ...(bccRecipients && { bccRecipients }),
      ...(opts.replyTo && {
        replyTo: [{ emailAddress: { address: opts.replyTo } }],
      }),
    },
    saveToSentItems: true,
  };
}

// ── Internal send executor (called by approval gate) ──────────────────

export async function executeOutlookSend(
  payload: Record<string, unknown>,
  ctx: { agentId: string; sessionKey: string },
): Promise<ReturnType<typeof txt>> {
  const config = payload.config as OutlookOAuthConfig | undefined;
  if (!config) return txt("Missing Outlook config in payload.");

  const email = String(payload.fromEmail);
  const creds = await getValidOutlookCredentials(ctx.agentId, ctx.sessionKey, email, config);
  if (!creds) return txt(`Outlook credentials expired for ${email}. Re-authenticate.`);

  const endpoint = payload.replyToMessageId
    ? `/me/messages/${String(payload.replyToMessageId)}/reply`
    : "/me/sendMail";

  let body: Record<string, unknown>;
  if (payload.replyToMessageId && payload.replyAll) {
    body = { comment: String(payload.body) };
    const result = await graphFetch(
      `/me/messages/${String(payload.replyToMessageId)}/replyAll`,
      creds,
      { method: "POST", body },
    );
    return result.ok ? txt("Reply-all sent successfully.") : txt(`Failed: ${result.error}`);
  }

  if (payload.replyToMessageId) {
    body = { comment: String(payload.body) };
    const result = await graphFetch(endpoint, creds, { method: "POST", body });
    return result.ok ? txt("Reply sent successfully.") : txt(`Failed: ${result.error}`);
  }

  body = buildMessagePayload({
    to: String(payload.to),
    subject: String(payload.subject),
    body: String(payload.body),
    cc: payload.cc ? String(payload.cc) : undefined,
    bcc: payload.bcc ? String(payload.bcc) : undefined,
  });

  const result = await graphFetch("/me/sendMail", creds, { method: "POST", body });
  return result.ok ? txt("Email sent successfully.") : txt(`Failed: ${result.error}`);
}

// ── Schema definitions ────────────────────────────────────────────────

const EmailParamBase = Type.Object({
  email: Type.String({ description: "Authenticated Outlook email account", minLength: 1 }),
});

const OutlookListSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  folderId: Type.Optional(
    Type.String({ description: 'Folder ID or well-known name (default: "inbox")' }),
  ),
  top: Type.Optional(
    Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 100 }),
  ),
  filter: Type.Optional(Type.String({ description: "OData filter (e.g. 'isRead eq false')" })),
  select: Type.Optional(Type.String({ description: "Comma-separated fields to return" })),
});

const OutlookReadSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  messageId: Type.String({ description: "Message ID", minLength: 1 }),
});

const OutlookSearchSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  query: Type.String({
    description: "KQL search query (e.g. 'subject:invoice from:boss@example.com')",
    minLength: 1,
  }),
  top: Type.Optional(
    Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 100 }),
  ),
  folderId: Type.Optional(Type.String({ description: "Restrict search to a folder" })),
});

const OutlookSendSchema = Type.Object({
  email: Type.String({ description: "Sender Outlook account email", minLength: 1 }),
  to: Type.String({ description: "Recipient(s), comma-separated", minLength: 1 }),
  subject: Type.String({ description: "Email subject", minLength: 1 }),
  body: Type.String({ description: "Email body (plain text)", minLength: 1 }),
  cc: Type.Optional(Type.String({ description: "CC recipient(s)" })),
  bcc: Type.Optional(Type.String({ description: "BCC recipient(s)" })),
  isHtml: Type.Optional(Type.Boolean({ description: "Body is HTML (default: false)" })),
  approved: Type.Optional(Type.Boolean({ description: "Bypass approval gate" })),
});

const OutlookReplySchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  messageId: Type.String({ description: "Message to reply to", minLength: 1 }),
  body: Type.String({ description: "Reply body", minLength: 1 }),
  replyAll: Type.Optional(Type.Boolean({ description: "Reply-all (default: false)" })),
  approved: Type.Optional(Type.Boolean({ description: "Bypass approval gate" })),
});

const OutlookForwardSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  messageId: Type.String({ description: "Message to forward", minLength: 1 }),
  to: Type.String({ description: "Forward-to recipient(s), comma-separated", minLength: 1 }),
  comment: Type.Optional(Type.String({ description: "Optional message to prepend" })),
  approved: Type.Optional(Type.Boolean({ description: "Bypass approval gate" })),
});

const OutlookMoveSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  messageId: Type.String({ description: "Message ID to move", minLength: 1 }),
  destinationFolderId: Type.String({
    description: 'Destination folder ID or well-known name (e.g. "archive", "deleteditems")',
    minLength: 1,
  }),
});

const OutlookFlagSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  messageId: Type.String({ description: "Message ID", minLength: 1 }),
  flag: Type.Union(
    [Type.Literal("flagged"), Type.Literal("complete"), Type.Literal("notFlagged")],
    { description: "Flag status" },
  ),
});

const OutlookCategorySchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  messageId: Type.String({ description: "Message ID", minLength: 1 }),
  categories: Type.Array(Type.String(), { description: "Category names to apply" }),
});

const OutlookCreateFolderSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  name: Type.String({ description: "Folder name", minLength: 1 }),
  parentFolderId: Type.Optional(
    Type.String({ description: "Parent folder ID (default: mailFolders root)" }),
  ),
});

const OutlookRulesSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
});

// ── Tool registration ─────────────────────────────────────────────────

export function registerOutlookMailTools(
  api: MinionPluginApi,
  config: OutlookOAuthConfig,
  requireApproval: boolean,
): void {
  // 1. outlook_list — list messages
  api.registerTool({
    name: "outlook_list",
    label: "Outlook: List Messages",
    description: "List Outlook messages in a folder. Supports OData filters.",
    parameters: OutlookListSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const folder = String(p.folderId ?? "inbox");
      const top = Number(p.top ?? 20);
      const filter = p.filter ? `?$filter=${encodeURIComponent(String(p.filter))}` : "";
      const select = p.select
        ? `${filter ? "&" : "?"}$select=${String(p.select)}`
        : `${filter ? "&" : "?"}$select=id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments`;
      const topParam = `${filter || select ? "&" : "?"}$top=${top}&$orderby=receivedDateTime desc`;

      const result = await graphFetch(
        `/me/mailFolders/${folder}/messages${filter}${select}${topParam}`,
        creds,
      );
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 2. outlook_read — read a message
  api.registerTool({
    name: "outlook_read",
    label: "Outlook: Read Message",
    description: "Read the full content of an Outlook message by ID.",
    parameters: OutlookReadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}`, creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 3. outlook_search — search messages
  api.registerTool({
    name: "outlook_search",
    label: "Outlook: Search Messages",
    description: "Search Outlook messages using KQL syntax.",
    parameters: OutlookSearchSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const top = Number(p.top ?? 20);
      const folder = p.folderId ? `/mailFolders/${String(p.folderId)}` : "";
      const query = encodeURIComponent(String(p.query));
      const result = await graphFetch(
        `/me${folder}/messages?$search="${query}"&$top=${top}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`,
        creds,
      );
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 4. outlook_send — send message (with approval gate)
  api.registerTool({
    name: "outlook_send",
    label: "Outlook: Send Email",
    description: "Send an Outlook email. Shows approval prompt unless approved=true.",
    parameters: OutlookSendSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const fromEmail = String(p.email);

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const summary = `To: ${p.to}\nSubject: ${p.subject}\n\nBody preview:\n${String(p.body).slice(0, 300)}${String(p.body).length > 300 ? "…" : ""}`;
        const entry = createPending({
          provider: "outlook",
          payload: { ...p, fromEmail, config },
          summary,
        });
        return txt(buildApprovalPrompt(entry));
      }

      const creds = await getOutlookCreds(api, fromEmail, config);
      if ("error" in creds) return txt(creds.error);

      const body = buildMessagePayload({
        to: String(p.to),
        subject: String(p.subject),
        body: String(p.body),
        cc: p.cc ? String(p.cc) : undefined,
        bcc: p.bcc ? String(p.bcc) : undefined,
        isHtml: p.isHtml === true,
      });

      const result = await graphFetch("/me/sendMail", creds, { method: "POST", body });
      return result.ok ? txt("Email sent successfully.") : txt(`Failed: ${result.error}`);
    },
  });

  // 5. outlook_reply — reply to message
  api.registerTool({
    name: "outlook_reply",
    label: "Outlook: Reply",
    description: "Reply to an Outlook message. Goes through approval gate unless approved=true.",
    parameters: OutlookReplySchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const fromEmail = String(p.email);

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const summary = `Reply to message ${p.messageId}${p.replyAll ? " (reply-all)" : ""}\n\nBody preview:\n${String(p.body).slice(0, 300)}`;
        const entry = createPending({
          provider: "outlook",
          payload: {
            fromEmail,
            replyToMessageId: p.messageId,
            body: p.body,
            replyAll: p.replyAll,
            config,
          },
          summary,
        });
        return txt(buildApprovalPrompt(entry));
      }

      const creds = await getOutlookCreds(api, fromEmail, config);
      if ("error" in creds) return txt(creds.error);

      const endpoint = p.replyAll
        ? `/me/messages/${String(p.messageId)}/replyAll`
        : `/me/messages/${String(p.messageId)}/reply`;
      const result = await graphFetch(endpoint, creds, {
        method: "POST",
        body: { comment: String(p.body) },
      });
      return result.ok ? txt("Reply sent.") : txt(`Failed: ${result.error}`);
    },
  });

  // 6. outlook_reply_all — reply-all
  api.registerTool({
    name: "outlook_reply_all",
    label: "Outlook: Reply All",
    description: "Reply-all to an Outlook message.",
    parameters: OutlookReplySchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const fromEmail = String(p.email);

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const summary = `Reply-all to message ${p.messageId}\n\nBody preview:\n${String(p.body).slice(0, 300)}`;
        const entry = createPending({
          provider: "outlook",
          payload: {
            fromEmail,
            replyToMessageId: p.messageId,
            body: p.body,
            replyAll: true,
            config,
          },
          summary,
        });
        return txt(buildApprovalPrompt(entry));
      }

      const creds = await getOutlookCreds(api, fromEmail, config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}/replyAll`, creds, {
        method: "POST",
        body: { comment: String(p.body) },
      });
      return result.ok ? txt("Reply-all sent.") : txt(`Failed: ${result.error}`);
    },
  });

  // 7. outlook_forward — forward message
  api.registerTool({
    name: "outlook_forward",
    label: "Outlook: Forward",
    description: "Forward an Outlook message to new recipients.",
    parameters: OutlookForwardSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const fromEmail = String(p.email);

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const summary = `Forward message ${p.messageId} to: ${p.to}`;
        const entry = createPending({
          provider: "outlook",
          payload: {
            fromEmail,
            forwardMessageId: p.messageId,
            to: p.to,
            comment: p.comment,
            config,
          },
          summary,
        });
        return txt(buildApprovalPrompt(entry));
      }

      const creds = await getOutlookCreds(api, fromEmail, config);
      if ("error" in creds) return txt(creds.error);

      const toRecipients = String(p.to)
        .split(",")
        .map((e) => ({ emailAddress: { address: e.trim() } }));

      const result = await graphFetch(`/me/messages/${String(p.messageId)}/forward`, creds, {
        method: "POST",
        body: {
          comment: p.comment ? String(p.comment) : "",
          toRecipients,
        },
      });
      return result.ok ? txt("Forwarded successfully.") : txt(`Failed: ${result.error}`);
    },
  });

  // 8. outlook_move — move message to folder
  api.registerTool({
    name: "outlook_move",
    label: "Outlook: Move Message",
    description: "Move an Outlook message to a different folder.",
    parameters: OutlookMoveSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}/move`, creds, {
        method: "POST",
        body: { destinationId: String(p.destinationFolderId) },
      });
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 9. outlook_delete — delete message
  api.registerTool({
    name: "outlook_delete",
    label: "Outlook: Delete Message",
    description: "Delete (trash) an Outlook message.",
    parameters: OutlookReadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}`, creds, {
        method: "DELETE",
      });
      return result.ok ? txt("Message deleted.") : txt(`Failed: ${result.error}`);
    },
  });

  // 10. outlook_archive — move to archive folder
  api.registerTool({
    name: "outlook_archive",
    label: "Outlook: Archive Message",
    description: "Archive an Outlook message (move to Archive folder).",
    parameters: OutlookReadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}/move`, creds, {
        method: "POST",
        body: { destinationId: "archive" },
      });
      return result.ok ? txt("Message archived.") : txt(`Failed: ${result.error}`);
    },
  });

  // 11. outlook_mark_read — mark as read
  api.registerTool({
    name: "outlook_mark_read",
    label: "Outlook: Mark as Read",
    description: "Mark an Outlook message as read.",
    parameters: OutlookReadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}`, creds, {
        method: "PATCH",
        body: { isRead: true },
      });
      return result.ok ? txt("Marked as read.") : txt(`Failed: ${result.error}`);
    },
  });

  // 12. outlook_mark_unread — mark as unread
  api.registerTool({
    name: "outlook_mark_unread",
    label: "Outlook: Mark as Unread",
    description: "Mark an Outlook message as unread.",
    parameters: OutlookReadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}`, creds, {
        method: "PATCH",
        body: { isRead: false },
      });
      return result.ok ? txt("Marked as unread.") : txt(`Failed: ${result.error}`);
    },
  });

  // 13. outlook_flag — flag message for follow-up
  api.registerTool({
    name: "outlook_flag",
    label: "Outlook: Flag Message",
    description: "Flag an Outlook message for follow-up (flagged, complete, or notFlagged).",
    parameters: OutlookFlagSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}`, creds, {
        method: "PATCH",
        body: { flag: { flagStatus: String(p.flag) } },
      });
      return result.ok ? txt(`Message flagged as "${p.flag}".`) : txt(`Failed: ${result.error}`);
    },
  });

  // 14. outlook_categories_apply — apply categories to message
  api.registerTool({
    name: "outlook_categories_apply",
    label: "Outlook: Apply Categories",
    description:
      "Apply category tags to an Outlook message (e.g. 'Red Category', 'Blue Category').",
    parameters: OutlookCategorySchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/messages/${String(p.messageId)}`, creds, {
        method: "PATCH",
        body: { categories: p.categories },
      });
      return result.ok ? txt("Categories applied.") : txt(`Failed: ${result.error}`);
    },
  });

  // 15. outlook_categories_list — list master category list
  api.registerTool({
    name: "outlook_categories_list",
    label: "Outlook: List Categories",
    description: "List all available Outlook categories for the account.",
    parameters: EmailParamBase,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch("/me/outlook/masterCategories", creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 16. outlook_folders — list mail folders
  api.registerTool({
    name: "outlook_folders",
    label: "Outlook: List Folders",
    description: "List Outlook mail folders.",
    parameters: Type.Object({
      email: Type.String({ description: "Outlook account email", minLength: 1 }),
      parentFolderId: Type.Optional(
        Type.String({ description: "List children of this folder (omit for top-level)" }),
      ),
    }),
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const endpoint = p.parentFolderId
        ? `/me/mailFolders/${String(p.parentFolderId)}/childFolders`
        : "/me/mailFolders";
      const result = await graphFetch(endpoint, creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 17. outlook_create_folder — create mail folder
  api.registerTool({
    name: "outlook_create_folder",
    label: "Outlook: Create Folder",
    description: "Create a new Outlook mail folder.",
    parameters: OutlookCreateFolderSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const endpoint = p.parentFolderId
        ? `/me/mailFolders/${String(p.parentFolderId)}/childFolders`
        : "/me/mailFolders";
      const result = await graphFetch(endpoint, creds, {
        method: "POST",
        body: { displayName: String(p.name) },
      });
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 18. outlook_rules — list inbox rules
  api.registerTool({
    name: "outlook_rules",
    label: "Outlook: List Inbox Rules",
    description: "List Outlook inbox rules for the account.",
    parameters: OutlookRulesSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch("/me/mailFolders/inbox/messageRules", creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 19. outlook_draft_create — create draft
  api.registerTool({
    name: "outlook_draft_create",
    label: "Outlook: Create Draft",
    description: "Create a draft Outlook message without sending.",
    parameters: OutlookSendSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const message = buildMessagePayload({
        to: String(p.to),
        subject: String(p.subject),
        body: String(p.body),
        cc: p.cc ? String(p.cc) : undefined,
        bcc: p.bcc ? String(p.bcc) : undefined,
        isHtml: p.isHtml === true,
      });

      // Create as draft (POST to /messages, not /sendMail)
      const result = await graphFetch("/me/messages", creds, {
        method: "POST",
        body: (message as Record<string, unknown>).message,
      });
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 20. outlook_draft_list — list drafts
  api.registerTool({
    name: "outlook_draft_list",
    label: "Outlook: List Drafts",
    description: "List Outlook draft messages.",
    parameters: Type.Object({
      email: Type.String({ description: "Outlook account email", minLength: 1 }),
      top: Type.Optional(
        Type.Number({ description: "Max results (default: 10)", minimum: 1, maximum: 50 }),
      ),
    }),
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const top = Number(p.top ?? 10);
      const result = await graphFetch(
        `/me/mailFolders/drafts/messages?$top=${top}&$select=id,subject,toRecipients,createdDateTime,lastModifiedDateTime`,
        creds,
      );
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 21. outlook_inbox_summary — quick inbox overview
  api.registerTool({
    name: "outlook_inbox_summary",
    label: "Outlook: Inbox Summary",
    description:
      "Get a quick summary of the Outlook inbox: unread count, recent senders, and flagged items.",
    parameters: EmailParamBase,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const [unreadResult, flaggedResult] = await Promise.all([
        graphFetch(
          "/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=5&$select=id,subject,from,receivedDateTime",
          creds,
        ),
        graphFetch(
          "/me/messages?$filter=flag/flagStatus eq 'flagged'&$top=5&$select=id,subject,from,receivedDateTime",
          creds,
        ),
      ]);

      return json({
        unread: unreadResult.ok ? unreadResult.data : { error: unreadResult.error },
        flagged: flaggedResult.ok ? flaggedResult.data : { error: flaggedResult.error },
      });
    },
  });

  // 22. outlook_categorize — categorize Outlook message
  api.registerTool({
    name: "outlook_categorize",
    label: "Outlook: Categorize Message",
    description: "Classify an Outlook message using smart categorization rules.",
    parameters: Type.Object({
      email: Type.String({ description: "Outlook account email", minLength: 1 }),
      messageId: Type.Optional(Type.String({ description: "Message ID to fetch and categorize" })),
      from: Type.Optional(Type.String({ description: "Sender email (skip fetch if known)" })),
      subject: Type.Optional(Type.String({ description: "Subject (skip fetch if known)" })),
      applyCategory: Type.Optional(
        Type.Boolean({ description: "Auto-apply the suggested Outlook category (default: false)" }),
      ),
    }),
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getOutlookCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      let from: string | undefined = p.from ? String(p.from) : undefined;
      let subject: string | undefined = p.subject ? String(p.subject) : undefined;

      if (p.messageId && (!from || !subject)) {
        const readResult = await graphFetch(
          `/me/messages/${String(p.messageId)}?$select=from,subject`,
          creds,
        );
        if (readResult.ok) {
          const msg = readResult.data as Record<string, unknown>;
          const fromData = msg.from as Record<string, unknown> | undefined;
          from = String((fromData?.emailAddress as Record<string, unknown>)?.address ?? "");
          subject = String(msg.subject ?? "");
        }
      }

      const { categorizeEmail } = await import("./categorization.js");
      const result = categorizeEmail({ from, subject });

      if (p.applyCategory && p.messageId && result.suggestedLabel) {
        // Apply as Outlook category
        await graphFetch(`/me/messages/${String(p.messageId)}`, creds, {
          method: "PATCH",
          body: { categories: [result.suggestedLabel] },
        });
      }

      return json(result);
    },
  });
}
