/**
 * Append-only session event log for heartbeat agents.
 *
 * Implements the stateless-brain + event-log pattern from MIN-288.
 * Each heartbeat run appends one entry to a per-agent per-session JSONL
 * file in `{agentWorkspaceDir}/.session-logs/`. On the next heartbeat
 * for the same session, the compact replay is prepended to the prompt so
 * the agent can resume mid-task without relying on the full transcript.
 *
 * Gated by the `MINION_SESSION_LOG_ENABLED` env flag.
 *
 * Storage layout:
 *   {agentWorkspaceDir}/.session-logs/{sanitizedSessionKey}.jsonl
 *
 * Compaction: if the log exceeds MAX_LOG_ENTRIES lines, the oldest entries
 * are trimmed so only the latest MAX_LOG_ENTRIES lines are kept.
 *
 * @module
 */

import fs from "node:fs/promises";
import path from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of heartbeat run entries kept per session log before compaction. */
const MAX_LOG_ENTRIES = 20;

/**
 * Maximum characters from each prior run's reply text included in the
 * context block injected into the next heartbeat prompt.
 */
const REPLY_PREVIEW_MAX_CHARS = 500;

/** Sub-directory inside the agent workspace where log files are stored. */
const SESSION_LOG_DIR = ".session-logs";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One heartbeat run entry written to the JSONL log. */
export type SessionLogEntry = {
  /** Epoch timestamp (ms) when the heartbeat started. */
  ts: number;
  /** Opaque heartbeat run identifier (used for dedup / correlation). */
  runId?: string;
  /** The prompt body sent to the model in this heartbeat. */
  prompt: string;
  /**
   * The model's reply text (truncated to REPLY_PREVIEW_MAX_CHARS).
   * Empty string if the reply was empty (HEARTBEAT_OK only).
   */
  reply: string;
  /** Wall-clock duration of the heartbeat run in milliseconds. */
  durationMs: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a session key into a safe filename component (alphanumeric + dash/dot).
 * Preserves the key's readable structure while removing characters that would
 * break filesystem paths on any OS.
 */
export function sanitizeSessionKeyForFilename(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/** Return the absolute path of the JSONL log file for a given agent + session. */
export function resolveSessionLogPath(agentWorkspaceDir: string, sessionKey: string): string {
  const safe = sanitizeSessionKeyForFilename(sessionKey);
  return path.join(agentWorkspaceDir, SESSION_LOG_DIR, `${safe}.jsonl`);
}

/** Truncate a string to at most `max` characters, appending "…" if trimmed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max - 1) + "…";
}

// ── Core I/O ──────────────────────────────────────────────────────────────────

/**
 * Append one heartbeat run entry to the session log, then compact if needed.
 *
 * Creates the log directory if it does not exist. Never throws — errors are
 * logged to stderr so a log failure never aborts a heartbeat run.
 */
export async function appendSessionLogEntry(
  agentWorkspaceDir: string,
  sessionKey: string,
  entry: SessionLogEntry,
): Promise<void> {
  const logPath = resolveSessionLogPath(agentWorkspaceDir, sessionKey);
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(logPath, line, "utf-8");
    await compactSessionLog(logPath);
  } catch (err) {
    process.stderr.write(`[session-log] append failed path=${logPath} err=${String(err)}\n`);
  }
}

/**
 * Read and parse all entries from the session log for a given agent + session.
 *
 * Returns an empty array if the log does not exist or cannot be parsed.
 * Invalid JSONL lines are silently skipped.
 */
export async function readSessionLogEntries(
  agentWorkspaceDir: string,
  sessionKey: string,
): Promise<SessionLogEntry[]> {
  const logPath = resolveSessionLogPath(agentWorkspaceDir, sessionKey);
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch {
    return [];
  }
  const entries: SessionLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as SessionLogEntry).ts === "number"
      ) {
        entries.push(parsed as SessionLogEntry);
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * Trim the JSONL log file to at most MAX_LOG_ENTRIES lines (dropping oldest).
 * No-op if the file does not exist or already satisfies the limit.
 */
async function compactSessionLog(logPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= MAX_LOG_ENTRIES) {
    return;
  }
  const kept = lines.slice(lines.length - MAX_LOG_ENTRIES);
  try {
    await fs.writeFile(logPath, kept.join("\n") + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(`[session-log] compact failed path=${logPath} err=${String(err)}\n`);
  }
}

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Build the compact prior-session context block to prepend to the heartbeat
 * prompt.  Returns `null` if there are no prior entries.
 *
 * Example output:
 *
 * ```
 * ## Prior session context (last 3 runs)
 * [2026-04-11 00:10 UTC] prompt: "Process your tasks…" → "Checked MIN-288, starting impl…"
 * [2026-04-11 00:15 UTC] prompt: "Process your tasks…" → "Wrote session-log.ts, wiring…"
 * [2026-04-11 00:20 UTC] prompt: "Process your tasks…" → "Tests pass, submitting for rev…"
 * ---
 * ```
 */
export function buildSessionContextBlock(entries: SessionLogEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  const lines: string[] = [
    `## Prior session context (last ${entries.length} run${entries.length === 1 ? "" : "s"})`,
  ];
  for (const entry of entries) {
    const date = new Date(entry.ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const promptPreview = truncate(entry.prompt.replace(/\n+/g, " ").trim(), 120);
    const replyPreview = entry.reply.trim()
      ? truncate(entry.reply.replace(/\n+/g, " ").trim(), REPLY_PREVIEW_MAX_CHARS)
      : "(silent — HEARTBEAT_OK)";
    lines.push(`[${date}] prompt: "${promptPreview}" → "${replyPreview}"`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Inject prior session context into a heartbeat prompt.
 *
 * Prepends the session context block above the original prompt body.
 * Returns the original prompt unchanged if there are no prior entries.
 */
export function injectSessionContext(prompt: string, entries: SessionLogEntry[]): string {
  const block = buildSessionContextBlock(entries);
  if (!block) {
    return prompt;
  }
  return `${block}\n\n${prompt}`;
}

// ── Feature flag ──────────────────────────────────────────────────────────────

/**
 * Returns true when `MINION_SESSION_LOG_ENABLED` is set to a truthy value
 * (`"1"`, `"true"`, `"yes"`, `"on"`) — case-insensitive.
 */
export function isSessionLogEnabled(): boolean {
  const val = process.env["MINION_SESSION_LOG_ENABLED"]?.toLowerCase().trim() ?? "";
  return val === "1" || val === "true" || val === "yes" || val === "on";
}
