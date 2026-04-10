/**
 * Gmail tools for the MINION email + calendar module.
 *
 * 16 high-level tools wrapping the gog CLI with typed schemas.
 * All send tools go through the approval gate when requireApproval=true.
 */

import { Type } from "@sinclair/typebox";
import type { MinionPluginApi } from "minion/plugin-sdk";
import { buildApprovalPrompt, createPending } from "./approval-gate.js";
import { categorizeEmail } from "./categorization.js";
import { gogResultToContent, runGog, type GogContext } from "./gog-runner.js";

// ── Shared helpers ────────────────────────────────────────────────────

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: { text } };
}

function getCtx(api: MinionPluginApi): GogContext | null {
  const agentId = (api.runtime as unknown as Record<string, unknown>).agentId as string | undefined;
  const sessionKey = (api.runtime as unknown as Record<string, unknown>).sessionKey as
    | string
    | undefined;
  if (!agentId || !sessionKey) return null;
  return { agentId, sessionKey };
}

// ── Tool schemas ──────────────────────────────────────────────────────

const GmailListSchema = Type.Object({
  query: Type.Optional(
    Type.String({ description: 'Gmail search query (e.g. "is:unread newer_than:7d")' }),
  ),
  max: Type.Optional(
    Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 200 }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("minimal"), Type.Literal("full")], {
      description: 'Listing format: "minimal" (default) or "full" (includes body snippet)',
    }),
  ),
});

const GmailReadSchema = Type.Object({
  id: Type.String({ description: "Gmail message ID", minLength: 1 }),
  format: Type.Optional(
    Type.Union([Type.Literal("minimal"), Type.Literal("full"), Type.Literal("raw")], {
      description: 'Message format (default: "full")',
    }),
  ),
});

const GmailSearchSchema = Type.Object({
  query: Type.String({ description: "Gmail search query", minLength: 1 }),
  max: Type.Optional(
    Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 200 }),
  ),
});

const GmailSendSchema = Type.Object({
  to: Type.String({ description: "Recipient email address(es), comma-separated", minLength: 1 }),
  subject: Type.String({ description: "Email subject", minLength: 1 }),
  body: Type.String({ description: "Email body (plain text)", minLength: 1 }),
  cc: Type.Optional(Type.String({ description: "CC email address(es), comma-separated" })),
  bcc: Type.Optional(Type.String({ description: "BCC email address(es), comma-separated" })),
  approved: Type.Optional(
    Type.Boolean({ description: "Set true to bypass the approval gate (use for auto-replies)" }),
  ),
});

const GmailReplySchema = Type.Object({
  id: Type.String({ description: "Message ID to reply to", minLength: 1 }),
  body: Type.String({ description: "Reply body", minLength: 1 }),
  replyAll: Type.Optional(Type.Boolean({ description: "Reply-all (default: false)" })),
  approved: Type.Optional(Type.Boolean({ description: "Bypass approval gate" })),
});

const GmailIdSchema = Type.Object({
  id: Type.String({ description: "Gmail message ID", minLength: 1 }),
});

const GmailLabelAddSchema = Type.Object({
  id: Type.String({ description: "Gmail message ID", minLength: 1 }),
  label: Type.String({ description: "Label name to add", minLength: 1 }),
});

const GmailLabelRemoveSchema = Type.Object({
  id: Type.String({ description: "Gmail message ID", minLength: 1 }),
  label: Type.String({ description: "Label name to remove", minLength: 1 }),
});

const GmailLabelCreateSchema = Type.Object({
  name: Type.String({ description: "New label name", minLength: 1 }),
});

const GmailThreadSchema = Type.Object({
  threadId: Type.String({ description: "Gmail thread ID", minLength: 1 }),
});

const GmailDraftCreateSchema = Type.Object({
  to: Type.String({ description: "Recipient email address(es)", minLength: 1 }),
  subject: Type.String({ description: "Subject", minLength: 1 }),
  body: Type.String({ description: "Draft body", minLength: 1 }),
  cc: Type.Optional(Type.String({ description: "CC" })),
});

const GmailCategorizeSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Message ID to fetch and categorize" })),
  from: Type.Optional(Type.String({ description: "Sender email (skip fetch if already known)" })),
  subject: Type.Optional(Type.String({ description: "Subject (skip fetch if already known)" })),
  applyLabel: Type.Optional(
    Type.Boolean({ description: "Auto-apply suggested label in Gmail (default: false)" }),
  ),
});

const GmailConfirmSchema = Type.Object({
  token: Type.String({
    description: "Approval token from a previous gmail_send or gmail_reply call",
    minLength: 1,
  }),
});

const GmailCancelSchema = Type.Object({
  token: Type.String({ description: "Approval token to cancel", minLength: 1 }),
});

// ── Tool registration ─────────────────────────────────────────────────

export function registerGmailTools(api: MinionPluginApi, requireApproval: boolean): void {
  // 1. gmail_list — list recent messages
  api.registerTool({
    name: "gmail_list",
    label: "Gmail: List Messages",
    description:
      "List recent Gmail messages. Supports Gmail search syntax in the query parameter (e.g. 'is:unread', 'newer_than:7d', 'from:boss@example.com').",
    parameters: GmailListSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context. Cannot access Gmail.");
      let cmd = `gmail list`;
      if (p.query) cmd += ` --query "${String(p.query).replace(/"/g, '\\"')}"`;
      if (p.max) cmd += ` --max ${Number(p.max)}`;
      if (p.format === "full") cmd += " --format full";
      return gogResultToContent(await runGog(cmd, ctx, { service: "gmail" }));
    },
  });

  // 2. gmail_read — read a single message
  api.registerTool({
    name: "gmail_read",
    label: "Gmail: Read Message",
    description: "Read the full content of a Gmail message by its ID.",
    parameters: GmailReadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const format = String(p.format ?? "full");
      const cmd = `gmail read ${String(p.id)} --format ${format}`;
      return gogResultToContent(await runGog(cmd, ctx, { service: "gmail" }));
    },
  });

  // 3. gmail_search — search messages
  api.registerTool({
    name: "gmail_search",
    label: "Gmail: Search",
    description: "Search Gmail using full Gmail search syntax. Returns matching message summaries.",
    parameters: GmailSearchSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const max = Number(p.max ?? 20);
      const cmd = `gmail search "${String(p.query).replace(/"/g, '\\"')}" --max ${max}`;
      return gogResultToContent(await runGog(cmd, ctx, { service: "gmail" }));
    },
  });

  // 4. gmail_send — send email (with optional approval gate)
  api.registerTool({
    name: "gmail_send",
    label: "Gmail: Send Email",
    description:
      "Compose and send a Gmail message. When requireApproval is enabled (default), creates a pending confirmation request and returns a token the user must confirm before sending.",
    parameters: GmailSendSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const payload: Record<string, unknown> = {
        to: p.to,
        subject: p.subject,
        body: p.body,
        cc: p.cc,
        bcc: p.bcc,
      };

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const summary = `To: ${p.to}\nSubject: ${p.subject}\n\nBody preview:\n${String(p.body).slice(0, 300)}${String(p.body).length > 300 ? "…" : ""}`;
        const entry = createPending({ provider: "gmail", payload: { ...payload, ctx }, summary });
        return txt(buildApprovalPrompt(entry));
      }

      return gogResultToContent(
        await runGog(
          `gmail send --to "${String(p.to)}" --subject "${String(p.subject).replace(/"/g, '\\"')}" --body "${String(p.body).replace(/"/g, '\\"')}"` +
            (p.cc ? ` --cc "${String(p.cc)}"` : "") +
            (p.bcc ? ` --bcc "${String(p.bcc)}"` : ""),
          ctx,
          { service: "gmail" },
        ),
      );
    },
  });

  // 5. gmail_reply — reply to a message
  api.registerTool({
    name: "gmail_reply",
    label: "Gmail: Reply",
    description:
      "Reply to a Gmail message. Supports reply-all. Goes through approval gate unless approved=true.",
    parameters: GmailReplySchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const payload: Record<string, unknown> = { id: p.id, body: p.body, replyAll: p.replyAll };
      const needsApproval = requireApproval && !p.approved;

      if (needsApproval) {
        const summary = `Reply to message ${p.id}${p.replyAll ? " (reply-all)" : ""}\n\nBody preview:\n${String(p.body).slice(0, 300)}`;
        const entry = createPending({ provider: "gmail", payload: { ...payload, ctx }, summary });
        return txt(buildApprovalPrompt(entry));
      }

      const replyAll = p.replyAll === true;
      const cmd =
        `gmail reply ${String(p.id)} --body "${String(p.body).replace(/"/g, '\\"')}"` +
        (replyAll ? " --reply-all" : "");
      return gogResultToContent(await runGog(cmd, ctx, { service: "gmail" }));
    },
  });

  // 6. gmail_mark_read — mark message as read
  api.registerTool({
    name: "gmail_mark_read",
    label: "Gmail: Mark as Read",
    description: "Mark a Gmail message as read.",
    parameters: GmailIdSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail mark-read ${String(p.id)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 7. gmail_mark_unread — mark message as unread
  api.registerTool({
    name: "gmail_mark_unread",
    label: "Gmail: Mark as Unread",
    description: "Mark a Gmail message as unread.",
    parameters: GmailIdSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail mark-unread ${String(p.id)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 8. gmail_archive — archive a message
  api.registerTool({
    name: "gmail_archive",
    label: "Gmail: Archive",
    description: "Archive a Gmail message (remove from inbox).",
    parameters: GmailIdSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail archive ${String(p.id)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 9. gmail_delete — move message to trash
  api.registerTool({
    name: "gmail_delete",
    label: "Gmail: Move to Trash",
    description: "Move a Gmail message to trash.",
    parameters: GmailIdSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail trash ${String(p.id)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 10. gmail_star — star a message
  api.registerTool({
    name: "gmail_star",
    label: "Gmail: Star",
    description: "Star a Gmail message for follow-up.",
    parameters: GmailIdSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail star ${String(p.id)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 11. gmail_unstar — remove star
  api.registerTool({
    name: "gmail_unstar",
    label: "Gmail: Remove Star",
    description: "Remove the star from a Gmail message.",
    parameters: GmailIdSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail unstar ${String(p.id)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 12. gmail_label_add — add label to message
  api.registerTool({
    name: "gmail_label_add",
    label: "Gmail: Add Label",
    description: "Add a Gmail label to a message. Creates the label if it doesn't exist.",
    parameters: GmailLabelAddSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail label-add ${String(p.id)} --label "${String(p.label)}"`, ctx, {
          service: "gmail",
        }),
      );
    },
  });

  // 13. gmail_label_remove — remove label from message
  api.registerTool({
    name: "gmail_label_remove",
    label: "Gmail: Remove Label",
    description: "Remove a Gmail label from a message.",
    parameters: GmailLabelRemoveSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail label-remove ${String(p.id)} --label "${String(p.label)}"`, ctx, {
          service: "gmail",
        }),
      );
    },
  });

  // 14. gmail_label_list — list all labels
  api.registerTool({
    name: "gmail_label_list",
    label: "Gmail: List Labels",
    description: "List all Gmail labels in the account.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(await runGog("gmail labels", ctx, { service: "gmail" }));
    },
  });

  // 15. gmail_thread — get all messages in a thread
  api.registerTool({
    name: "gmail_thread",
    label: "Gmail: Get Thread",
    description: "Get all messages in a Gmail thread.",
    parameters: GmailThreadSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(
        await runGog(`gmail thread ${String(p.threadId)}`, ctx, { service: "gmail" }),
      );
    },
  });

  // 16. gmail_categorize — categorize email and optionally apply label
  api.registerTool({
    name: "gmail_categorize",
    label: "Gmail: Categorize Email",
    description:
      "Classify an email by category (urgent, newsletter, promotional, etc.) and priority. " +
      "Optionally applies the suggested Gmail label. Pass message ID to fetch and classify, " +
      "or provide from/subject directly.",
    parameters: GmailCategorizeSchema,
    async execute(_toolId, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      let from: string | undefined;
      let subject: string | undefined;

      if (p.id) {
        const readResult = await runGog(`gmail read ${String(p.id)} --format minimal`, ctx, {
          service: "gmail",
        });
        if (!readResult.ok) return gogResultToContent(readResult);
        const data = readResult.data as Record<string, unknown>;
        from = String(data.from ?? "");
        subject = String(data.subject ?? "");
      } else {
        from = p.from ? String(p.from) : undefined;
        subject = p.subject ? String(p.subject) : undefined;
      }

      const result = categorizeEmail({ from, subject });

      if (p.applyLabel && p.id) {
        // Best-effort: apply suggested label
        await runGog(`gmail label-add ${String(p.id)} --label "${result.suggestedLabel}"`, ctx, {
          service: "gmail",
        });
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // 17. gmail_draft_create — create a draft
  api.registerTool({
    name: "gmail_draft_create",
    label: "Gmail: Create Draft",
    description: "Create a Gmail draft without sending it.",
    parameters: GmailDraftCreateSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const cmd =
        `gmail draft --to "${String(p.to)}" --subject "${String(p.subject).replace(/"/g, '\\"')}" --body "${String(p.body).replace(/"/g, '\\"')}"` +
        (p.cc ? ` --cc "${String(p.cc)}"` : "");
      return gogResultToContent(await runGog(cmd, ctx, { service: "gmail" }));
    },
  });

  // 18. gmail_draft_list — list drafts
  api.registerTool({
    name: "gmail_draft_list",
    label: "Gmail: List Drafts",
    description: "List Gmail drafts.",
    parameters: Type.Object({
      max: Type.Optional(
        Type.Number({ description: "Max results (default: 10)", minimum: 1, maximum: 50 }),
      ),
    }),
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const max = Number(p.max ?? 10);
      return gogResultToContent(
        await runGog(`gmail drafts --max ${max}`, ctx, { service: "gmail" }),
      );
    },
  });

  // Approval gate: confirm send
  api.registerTool({
    name: "email_send_confirm",
    label: "Email: Confirm Send",
    description:
      "Confirm a pending Gmail or Outlook email send. Use the token returned by gmail_send, gmail_reply, outlook_send, or outlook_reply.",
    parameters: GmailConfirmSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const { consumePending } = await import("./approval-gate.js");
      const entry = consumePending(String(p.token));
      if (!entry) {
        return txt(
          `No pending send found for token "${p.token}". It may have expired or already been confirmed.`,
        );
      }

      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      if (entry.provider === "gmail") {
        const { id, body, replyAll, to, subject, cc, bcc } = entry.payload as Record<
          string,
          unknown
        >;
        let cmd: string;
        if (id) {
          cmd =
            `gmail reply ${String(id)} --body "${String(body).replace(/"/g, '\\"')}"` +
            (replyAll ? " --reply-all" : "");
        } else {
          cmd =
            `gmail send --to "${String(to)}" --subject "${String(subject).replace(/"/g, '\\"')}" --body "${String(body).replace(/"/g, '\\"')}"` +
            (cc ? ` --cc "${String(cc)}"` : "") +
            (bcc ? ` --bcc "${String(bcc)}"` : "");
        }
        return gogResultToContent(await runGog(cmd, ctx, { service: "gmail" }));
      }

      if (entry.provider === "outlook") {
        // Delegated to outlook send logic via dynamic import
        const { executeOutlookSend } = await import("./outlook-mail-tools.js");
        return await executeOutlookSend(entry.payload, ctx);
      }

      return txt(`Unknown provider "${entry.provider}"`);
    },
  });

  // Approval gate: cancel send
  api.registerTool({
    name: "email_send_cancel",
    label: "Email: Cancel Send",
    description: "Cancel a pending Gmail or Outlook send by its approval token.",
    parameters: GmailCancelSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const { cancelPending } = await import("./approval-gate.js");
      const found = cancelPending(String(p.token));
      return txt(
        found
          ? `Pending send ${p.token} cancelled.`
          : `No pending send found for token "${p.token}".`,
      );
    },
  });

  // Pending list
  api.registerTool({
    name: "email_send_pending",
    label: "Email: List Pending Sends",
    description: "List all pending email send approvals (not yet confirmed or expired).",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const { listPending } = await import("./approval-gate.js");
      const entries = listPending();
      if (entries.length === 0) return txt("No pending email sends.");
      const lines = entries.map((e) => {
        const expiresIn = Math.round((e.expiresAt - Date.now()) / 60_000);
        return `• [${e.token}] ${e.provider.toUpperCase()} — expires in ~${expiresIn}m\n  ${e.summary.split("\n")[0]}`;
      });
      return txt(lines.join("\n\n"));
    },
  });
}
