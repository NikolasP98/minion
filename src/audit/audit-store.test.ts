import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditStore } from "./audit-store.js";
import type { AuditEntry } from "./audit-types.js";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "test-id",
    timestamp: new Date().toISOString(),
    toolName: "bash",
    params: { cmd: "ls" },
    paramCategories: ["file_content"],
    consentScope: "implicit",
    violations: [],
    ...overrides,
  };
}

describe("AuditStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("append", () => {
    it("creates the log directory if it does not exist", async () => {
      const nestedDir = path.join(tmpDir, "nested", "audit");
      const store = new AuditStore({ dir: nestedDir, enabled: true });
      const entry = makeEntry();

      await store.append(entry);

      expect(fs.existsSync(nestedDir)).toBe(true);
    });

    it("writes one JSONL line per entry", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: true });
      const entry1 = makeEntry({ id: "id-1" });
      const entry2 = makeEntry({ id: "id-2" });

      await store.append(entry1);
      await store.append(entry2);

      const dateStr = new Date().toISOString().slice(0, 10);
      const filePath = path.join(tmpDir, `audit-${dateStr}.jsonl`);
      const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ id: "id-1" });
      expect(JSON.parse(lines[1])).toMatchObject({ id: "id-2" });
    });

    it("is a no-op when enabled is false", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: false });
      await store.append(makeEntry());

      const files = fs.readdirSync(tmpDir);
      expect(files).toHaveLength(0);
    });

    it("rotates files by date (one file per day)", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: true });

      // Manually write an entry to a past date file
      const pastDate = "2025-01-01";
      const pastPath = path.join(tmpDir, `audit-${pastDate}.jsonl`);
      fs.writeFileSync(pastPath, `${JSON.stringify(makeEntry({ id: "old-entry" }))}\n`);

      const todayEntry = makeEntry({ id: "today-entry" });
      await store.append(todayEntry);

      const files = fs.readdirSync(tmpDir).toSorted();
      // Today's file and the manually written past file
      expect(files).toHaveLength(2);
      expect(files[0]).toBe(`audit-${pastDate}.jsonl`);

      // Today's file contains only today's entry
      const todayDate = new Date().toISOString().slice(0, 10);
      const todayPath = path.join(tmpDir, `audit-${todayDate}.jsonl`);
      if (todayDate !== pastDate) {
        const todayLines = fs.readFileSync(todayPath, "utf-8").split("\n").filter(Boolean);
        expect(todayLines).toHaveLength(1);
        expect(JSON.parse(todayLines[0])).toMatchObject({ id: "today-entry" });
      }
    });
  });

  describe("readRange", () => {
    it("returns empty array when no files exist in range", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: true });
      const from = new Date("2024-01-01T00:00:00Z");
      const to = new Date("2024-01-03T23:59:59Z");

      const result = await store.readRange(from, to);

      expect(result).toEqual([]);
    });

    it("returns empty array when enabled is false", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: false });
      const entry = makeEntry({ id: "x", timestamp: new Date().toISOString() });
      const dateStr = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(path.join(tmpDir, `audit-${dateStr}.jsonl`), `${JSON.stringify(entry)}\n`);

      const from = new Date(0);
      const to = new Date(Date.now() + 86400000);
      const result = await store.readRange(from, to);

      expect(result).toEqual([]);
    });

    it("reads entries within the given range", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: true });

      const inside = makeEntry({ id: "inside", timestamp: "2024-06-15T12:00:00.000Z" });
      const before = makeEntry({ id: "before", timestamp: "2024-06-14T23:59:59.999Z" });
      const after = makeEntry({ id: "after", timestamp: "2024-06-16T00:00:00.001Z" });

      fs.writeFileSync(path.join(tmpDir, "audit-2024-06-14.jsonl"), `${JSON.stringify(before)}\n`);
      fs.writeFileSync(path.join(tmpDir, "audit-2024-06-15.jsonl"), `${JSON.stringify(inside)}\n`);
      fs.writeFileSync(path.join(tmpDir, "audit-2024-06-16.jsonl"), `${JSON.stringify(after)}\n`);

      const from = new Date("2024-06-15T00:00:00.000Z");
      const to = new Date("2024-06-15T23:59:59.999Z");
      const result = await store.readRange(from, to);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("inside");
    });

    it("skips malformed lines silently", async () => {
      const store = new AuditStore({ dir: tmpDir, enabled: true });
      const good = makeEntry({ id: "good", timestamp: "2024-06-15T10:00:00.000Z" });
      const dateFile = path.join(tmpDir, "audit-2024-06-15.jsonl");

      fs.writeFileSync(dateFile, `not-valid-json\n${JSON.stringify(good)}\n{broken\n`);

      const from = new Date("2024-06-15T00:00:00.000Z");
      const to = new Date("2024-06-15T23:59:59.999Z");
      const result = await store.readRange(from, to);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("good");
    });
  });
});
