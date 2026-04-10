/**
 * AuditStore — append-only JSONL audit log writer.
 *
 * Compliance requirements:
 * - One record per line (JSONL / newline-delimited JSON)
 * - Files rotate daily: audit-YYYY-MM-DD.jsonl
 * - Entries are flushed to disk immediately after each write (no buffering)
 * - Files are never deleted or truncated, only appended
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEntry } from "./audit-types.js";

export type AuditStoreOptions = {
  /** Directory to store audit log files. Default: ~/.minion/audit/ */
  dir: string;
  /** Whether the audit store is active. When false, writes are no-ops. */
  enabled: boolean;
};

export class AuditStore {
  private readonly dir: string;
  private readonly enabled: boolean;

  constructor(opts: AuditStoreOptions) {
    this.dir = opts.dir;
    this.enabled = opts.enabled;
  }

  private getFilePath(date: Date): string {
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(this.dir, `audit-${dateStr}.jsonl`);
  }

  /**
   * Append one AuditEntry to today's log file.
   *
   * Flushes to disk after each write (compliance: no buffering).
   * Creates the log directory if it does not exist.
   */
  async append(entry: AuditEntry): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await fs.promises.mkdir(this.dir, { recursive: true });

    const filePath = this.getFilePath(new Date());
    const line = `${JSON.stringify(entry)}\n`;

    const fd = await fs.promises.open(filePath, "a");
    try {
      await fd.write(line);
      await fd.datasync();
    } finally {
      await fd.close();
    }
  }

  /**
   * Read all AuditEntries with timestamps in [from, to].
   *
   * Iterates daily log files covering the range. Skips missing files
   * (days with no audit activity). Skips malformed lines silently.
   */
  async readRange(from: Date, to: Date): Promise<AuditEntry[]> {
    const entries: AuditEntry[] = [];

    if (!this.enabled) {
      return entries;
    }

    // Walk day by day from floor(from) to ceil(to)
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const endDay = new Date(to);
    endDay.setHours(23, 59, 59, 999);

    while (cursor <= endDay) {
      const filePath = this.getFilePath(cursor);

      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        for (const raw of content.split("\n")) {
          const line = raw.trim();
          if (!line) {
            continue;
          }
          try {
            const entry = JSON.parse(line) as AuditEntry;
            const ts = new Date(entry.timestamp);
            if (ts >= from && ts <= to) {
              entries.push(entry);
            }
          } catch {
            // Malformed line — skip
          }
        }
      } catch (err: unknown) {
        // No log file for this day — that is fine
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return entries;
  }
}

/** Create an AuditStore with defaults suitable for production use. */
export function createAuditStore(opts: Partial<AuditStoreOptions> = {}): AuditStore {
  return new AuditStore({
    dir: opts.dir ?? path.join(os.homedir(), ".minion", "audit"),
    enabled: opts.enabled ?? true,
  });
}
