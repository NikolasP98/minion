import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSessionLogEntry,
  buildSessionContextBlock,
  injectSessionContext,
  isSessionLogEnabled,
  readSessionLogEntries,
  resolveSessionLogPath,
  sanitizeSessionKeyForFilename,
  type SessionLogEntry,
} from "./session-log.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    ts: 1_744_329_000_000,
    runId: "run-001",
    prompt: "Process your Paperclip tasks",
    reply: "Checked MIN-288. Starting session log implementation.",
    durationMs: 3500,
    ...overrides,
  };
}

// ── sanitizeSessionKeyForFilename ─────────────────────────────────────────────

describe("sanitizeSessionKeyForFilename", () => {
  it("passes safe characters through unchanged", () => {
    expect(sanitizeSessionKeyForFilename("agent-123.session")).toBe("agent-123.session");
  });

  it("replaces slashes and special chars with underscores", () => {
    expect(sanitizeSessionKeyForFilename("agent/123:key!")).toBe("agent_123_key_");
  });

  it("truncates to 200 characters", () => {
    const long = "a".repeat(300);
    expect(sanitizeSessionKeyForFilename(long).length).toBe(200);
  });
});

// ── resolveSessionLogPath ─────────────────────────────────────────────────────

describe("resolveSessionLogPath", () => {
  it("nests the file under .session-logs in the workspace dir", () => {
    const result = resolveSessionLogPath("/home/agent/workspace", "my-session");
    expect(result).toBe("/home/agent/workspace/.session-logs/my-session.jsonl");
  });

  it("sanitizes the session key in the filename", () => {
    const result = resolveSessionLogPath("/ws", "agent/task:123");
    expect(result).toBe("/ws/.session-logs/agent_task_123.jsonl");
  });
});

// ── buildSessionContextBlock ──────────────────────────────────────────────────

describe("buildSessionContextBlock", () => {
  it("returns null for empty entries", () => {
    expect(buildSessionContextBlock([])).toBeNull();
  });

  it("includes a header with the count", () => {
    const block = buildSessionContextBlock([makeEntry()]);
    expect(block).toContain("Prior session context (last 1 run)");
  });

  it("uses plural for multiple runs", () => {
    const block = buildSessionContextBlock([makeEntry(), makeEntry({ ts: 1_744_329_060_000 })]);
    expect(block).toContain("last 2 runs");
  });

  it("includes truncated prompt and reply in each line", () => {
    const block = buildSessionContextBlock([
      makeEntry({ prompt: "Process tasks", reply: "Did the thing" }),
    ]);
    expect(block).toContain('prompt: "Process tasks"');
    expect(block).toContain('"Did the thing"');
  });

  it("shows silent marker when reply is empty", () => {
    const block = buildSessionContextBlock([makeEntry({ reply: "" })]);
    expect(block).toContain("(silent — HEARTBEAT_OK)");
  });

  it("ends with a horizontal rule", () => {
    const block = buildSessionContextBlock([makeEntry()]);
    expect(block).toMatch(/---\s*$/);
  });
});

// ── injectSessionContext ──────────────────────────────────────────────────────

describe("injectSessionContext", () => {
  it("returns original prompt when entries are empty", () => {
    const prompt = "Do your tasks";
    expect(injectSessionContext(prompt, [])).toBe(prompt);
  });

  it("prepends session context block above the prompt", () => {
    const prompt = "Do your tasks";
    const result = injectSessionContext(prompt, [makeEntry()]);
    expect(result).toContain("Prior session context");
    expect(result).toContain("---");
    expect(result).toContain("Do your tasks");
    // context block comes before the prompt
    const contextIdx = result.indexOf("Prior session context");
    const promptIdx = result.lastIndexOf("Do your tasks");
    expect(contextIdx).toBeLessThan(promptIdx);
  });
});

// ── isSessionLogEnabled ───────────────────────────────────────────────────────

describe("isSessionLogEnabled", () => {
  const ORIGINAL = process.env["MINION_SESSION_LOG_ENABLED"];
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env["MINION_SESSION_LOG_ENABLED"];
    } else {
      process.env["MINION_SESSION_LOG_ENABLED"] = ORIGINAL;
    }
  });

  it("returns false when env var is unset", () => {
    delete process.env["MINION_SESSION_LOG_ENABLED"];
    expect(isSessionLogEnabled()).toBe(false);
  });

  it("returns true for '1'", () => {
    process.env["MINION_SESSION_LOG_ENABLED"] = "1";
    expect(isSessionLogEnabled()).toBe(true);
  });

  it("returns true for 'true' (case-insensitive)", () => {
    process.env["MINION_SESSION_LOG_ENABLED"] = "TRUE";
    expect(isSessionLogEnabled()).toBe(true);
  });

  it("returns true for 'yes'", () => {
    process.env["MINION_SESSION_LOG_ENABLED"] = "yes";
    expect(isSessionLogEnabled()).toBe(true);
  });

  it("returns true for 'on'", () => {
    process.env["MINION_SESSION_LOG_ENABLED"] = "on";
    expect(isSessionLogEnabled()).toBe(true);
  });

  it("returns false for '0'", () => {
    process.env["MINION_SESSION_LOG_ENABLED"] = "0";
    expect(isSessionLogEnabled()).toBe(false);
  });

  it("returns false for 'false'", () => {
    process.env["MINION_SESSION_LOG_ENABLED"] = "false";
    expect(isSessionLogEnabled()).toBe(false);
  });
});

// ── appendSessionLogEntry + readSessionLogEntries ─────────────────────────────

describe("append and read session log entries", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-log-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the log directory and file on first write", async () => {
    const entry = makeEntry();
    await appendSessionLogEntry(tmpDir, "test-session", entry);
    const logPath = resolveSessionLogPath(tmpDir, "test-session");
    const exists = await fs
      .access(logPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("reads back the entry that was written", async () => {
    const entry = makeEntry({ prompt: "hello", reply: "world" });
    await appendSessionLogEntry(tmpDir, "test-session", entry);
    const entries = await readSessionLogEntries(tmpDir, "test-session");
    expect(entries).toHaveLength(1);
    expect(entries[0].prompt).toBe("hello");
    expect(entries[0].reply).toBe("world");
  });

  it("appends multiple entries in order", async () => {
    await appendSessionLogEntry(tmpDir, "s", makeEntry({ ts: 1000, reply: "first" }));
    await appendSessionLogEntry(tmpDir, "s", makeEntry({ ts: 2000, reply: "second" }));
    await appendSessionLogEntry(tmpDir, "s", makeEntry({ ts: 3000, reply: "third" }));
    const entries = await readSessionLogEntries(tmpDir, "s");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.reply)).toEqual(["first", "second", "third"]);
  });

  it("returns empty array when log does not exist", async () => {
    const entries = await readSessionLogEntries(tmpDir, "nonexistent-session");
    expect(entries).toEqual([]);
  });

  it("compacts the log to MAX_LOG_ENTRIES after overflow", async () => {
    // Write 25 entries (MAX_LOG_ENTRIES = 20)
    for (let i = 0; i < 25; i++) {
      await appendSessionLogEntry(tmpDir, "compact-test", makeEntry({ ts: i, reply: `run-${i}` }));
    }
    const entries = await readSessionLogEntries(tmpDir, "compact-test");
    expect(entries.length).toBeLessThanOrEqual(20);
    // Latest entries should be kept
    const lastReply = entries[entries.length - 1].reply;
    expect(lastReply).toBe("run-24");
  });

  it("skips invalid JSONL lines without throwing", async () => {
    const logPath = resolveSessionLogPath(tmpDir, "corrupt-session");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(
      logPath,
      `${JSON.stringify(makeEntry({ reply: "good" }))}\nnot-valid-json\n${JSON.stringify(makeEntry({ reply: "also-good" }))}\n`,
      "utf-8",
    );
    const entries = await readSessionLogEntries(tmpDir, "corrupt-session");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.reply)).toEqual(["good", "also-good"]);
  });
});
