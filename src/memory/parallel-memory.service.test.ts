import { describe, expect, it, vi } from "vitest";

import type { Mem0Adapter, Mem0ChatMessage, Mem0Memory } from "./mem0-adapter.js";
import { ParallelMemoryService } from "./parallel-memory.service.js";
import type { MemorySearchManager, MemorySearchResult } from "./types.js";

// ── test doubles ──────────────────────────────────────────────────────────────

function makePrimary(
  results: MemorySearchResult[] | Error,
): Pick<MemorySearchManager, "search"> & MemorySearchManager {
  return {
    search: vi.fn().mockImplementation(() =>
      results instanceof Error ? Promise.reject(results) : Promise.resolve(results),
    ),
    readFile: vi.fn(),
    status: vi.fn().mockReturnValue({ backend: "builtin", provider: "none" }),
    probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
    probeVectorAvailability: vi.fn().mockResolvedValue(false),
  };
}

function makeMem0(
  results: Mem0Memory[] | Error,
): Mem0Adapter {
  return {
    search: vi.fn().mockImplementation(() =>
      results instanceof Error ? Promise.reject(results) : Promise.resolve(results),
    ),
    add: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as Mem0Adapter;
}

const PRIMARY_RESULT: MemorySearchResult = {
  path: "memory/notes.md",
  startLine: 1,
  endLine: 5,
  score: 0.9,
  snippet: "User likes cats",
  source: "memory",
};

const MEM0_RESULT: Mem0Memory = {
  id: "m1",
  memory: "User speaks French",
  userId: "telegram:123",
  score: 0.85,
};

// ── ParallelMemoryService.search ──────────────────────────────────────────────

describe("ParallelMemoryService.search — both succeed", () => {
  it("returns both primary and supplemental results", async () => {
    const svc = new ParallelMemoryService(makePrimary([PRIMARY_RESULT]), makeMem0([MEM0_RESULT]));
    const result = await svc.search("query", "telegram:123");
    expect(result.primary).toEqual([PRIMARY_RESULT]);
    expect(result.supplemental).toEqual([MEM0_RESULT]);
    expect(result.usedMem0Fallback).toBe(false);
  });
});

describe("ParallelMemoryService.search — primary fails", () => {
  it("returns empty primary + mem0 results, usedMem0Fallback=true", async () => {
    const svc = new ParallelMemoryService(
      makePrimary(new Error("db crash")),
      makeMem0([MEM0_RESULT]),
    );
    const result = await svc.search("query", "telegram:123");
    expect(result.primary).toEqual([]);
    expect(result.supplemental).toEqual([MEM0_RESULT]);
    expect(result.usedMem0Fallback).toBe(true);
  });

  it("returns empty arrays when both fail", async () => {
    const svc = new ParallelMemoryService(
      makePrimary(new Error("db crash")),
      makeMem0(new Error("mem0 down")),
    );
    const result = await svc.search("query", "telegram:123");
    expect(result.primary).toEqual([]);
    expect(result.supplemental).toEqual([]);
    expect(result.usedMem0Fallback).toBe(false);
  });
});

describe("ParallelMemoryService.search — mem0 fails", () => {
  it("primary still preserved when mem0 fails", async () => {
    const svc = new ParallelMemoryService(
      makePrimary([PRIMARY_RESULT]),
      makeMem0(new Error("timeout")),
    );
    const result = await svc.search("query", "telegram:123");
    expect(result.primary).toEqual([PRIMARY_RESULT]);
    expect(result.supplemental).toEqual([]);
    expect(result.usedMem0Fallback).toBe(false);
  });
});

describe("ParallelMemoryService.search — no mem0 adapter", () => {
  it("returns primary results with empty supplemental when mem0 is null", async () => {
    const svc = new ParallelMemoryService(makePrimary([PRIMARY_RESULT]), null);
    const result = await svc.search("query", "telegram:123");
    expect(result.primary).toEqual([PRIMARY_RESULT]);
    expect(result.supplemental).toEqual([]);
    expect(result.usedMem0Fallback).toBe(false);
  });
});

// ── ParallelMemoryService.write ───────────────────────────────────────────────

describe("ParallelMemoryService.write", () => {
  it("awaits primary write and fires mem0 add asynchronously", async () => {
    const mem0 = makeMem0([]);
    const svc = new ParallelMemoryService(makePrimary([]), mem0);
    const messages: Mem0ChatMessage[] = [{ role: "user", content: "hello" }];
    const writePrimary = vi.fn().mockResolvedValue(undefined);

    await svc.write(messages, "telegram:123", writePrimary);

    expect(writePrimary).toHaveBeenCalledWith(messages);
    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(mem0.add).toHaveBeenCalledWith(messages, "telegram:123");
  });

  it("re-throws primary write errors", async () => {
    const svc = new ParallelMemoryService(makePrimary([]), null);
    const writePrimary = vi.fn().mockRejectedValue(new Error("primary write failed"));
    await expect(svc.write([], "u", writePrimary)).rejects.toThrow("primary write failed");
  });

  it("does not throw when mem0 add fails", async () => {
    const mem0 = makeMem0(new Error("mem0 error"));
    vi.mocked(mem0.add).mockRejectedValue(new Error("mem0 add failed"));
    const svc = new ParallelMemoryService(makePrimary([]), mem0);
    const writePrimary = vi.fn().mockResolvedValue(undefined);
    await expect(svc.write([], "u", writePrimary)).resolves.toBeUndefined();
  });

  it("skips mem0 add when adapter is null", async () => {
    const svc = new ParallelMemoryService(makePrimary([]), null);
    const writePrimary = vi.fn().mockResolvedValue(undefined);
    await svc.write([], "u", writePrimary);
    // no error
  });
});
