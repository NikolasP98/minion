/**
 * Approval gate for outbound email sends.
 *
 * When requireApproval=true (default), sending tools create a PendingEmail
 * keyed by a confirmation token and return a prompt asking the user to confirm.
 * The corresponding confirm tool finds the token and executes the actual send.
 */

import { randomBytes } from "node:crypto";

export type EmailProvider = "gmail" | "outlook";

export type PendingEmail = {
  /** Short token shown to user to confirm the send */
  token: string;
  /** Which provider will execute the send */
  provider: EmailProvider;
  /** Opaque payload passed back to the provider send function */
  payload: Record<string, unknown>;
  /** Human-readable summary shown in the confirmation prompt */
  summary: string;
  /** Epoch ms when this pending entry was created */
  createdAt: number;
  /** Epoch ms when this pending entry expires */
  expiresAt: number;
};

// In-process store of pending sends.
// Each gateway process has its own store; not persisted across restarts.
const pending = new Map<string, PendingEmail>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expiresAt < now) {
      pending.delete(token);
    }
  }
}

/** Create a pending send and return the confirmation token. */
export function createPending(opts: {
  provider: EmailProvider;
  payload: Record<string, unknown>;
  summary: string;
  timeoutMs?: number;
}): PendingEmail {
  pruneExpired();
  const token = randomBytes(4).toString("hex").toUpperCase(); // e.g. "A3F9"
  const now = Date.now();
  const entry: PendingEmail = {
    token,
    provider: opts.provider,
    payload: opts.payload,
    summary: opts.summary,
    createdAt: now,
    expiresAt: now + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  pending.set(token, entry);
  return entry;
}

/** Consume a pending send by token. Returns null if not found or expired. */
export function consumePending(token: string): PendingEmail | null {
  pruneExpired();
  const key = token.trim().toUpperCase();
  const entry = pending.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    pending.delete(key);
    return null;
  }
  pending.delete(key);
  return entry;
}

/** Cancel (delete) a pending send. Returns true if it existed. */
export function cancelPending(token: string): boolean {
  return pending.delete(token.trim().toUpperCase());
}

/** List all non-expired pending sends (for status display). */
export function listPending(): PendingEmail[] {
  pruneExpired();
  return [...pending.values()];
}

/**
 * Build the approval-request message shown to the user.
 * Called by send tools when requireApproval=true.
 */
export function buildApprovalPrompt(entry: PendingEmail): string {
  const expiresInMin = Math.round((entry.expiresAt - Date.now()) / 60_000);
  return (
    `📧 **Email ready to send** (token: \`${entry.token}\`)\n\n` +
    `${entry.summary}\n\n` +
    `To send: call \`email_send_confirm\` with token \`${entry.token}\`\n` +
    `To cancel: call \`email_send_cancel\` with token \`${entry.token}\`\n` +
    `Expires in ~${expiresInMin} minutes.`
  );
}
