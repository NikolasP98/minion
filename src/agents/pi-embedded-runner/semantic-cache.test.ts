/**
 * Unit tests for QdrantSemanticCache.
 *
 * All Qdrant HTTP calls are intercepted via vi.spyOn(globalThis, 'fetch').
 * No live Qdrant server is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiEmbeddingFn,
  isSemanticCacheEnabled,
  OPENAI_EMBEDDING_3_SMALL_DIMS,
  QdrantSemanticCache,
  resolveDefaultSemanticCache,
  resolveSemanticCacheThreshold,
} from "./semantic-cache.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a tiny fake embedding vector of the given dimension. */
const fakeVec = (dim: number, seed = 1): number[] =>
  Array.from({ length: dim }, (_, i) => Math.sin(i * seed));

/** Constant embedding fn — always returns the same vector. */
const constantEmbedFn = (dim: number) => async (_text: string) => fakeVec(dim, 1);

/** Build a cache instance backed by a mocked fetch. */
function makeCache(opts?: { threshold?: number; maxEntries?: number; ttlSeconds?: number }) {
  return new QdrantSemanticCache({
    qdrantUrl: "http://qdrant.test:6333",
    embeddingFn: constantEmbedFn(OPENAI_EMBEDDING_3_SMALL_DIMS),
    vectorSize: OPENAI_EMBEDDING_3_SMALL_DIMS,
    similarityThreshold: opts?.threshold ?? 0.85,
    maxEntries: opts?.maxEntries ?? 10_000,
    ttlSeconds: opts?.ttlSeconds ?? 86_400,
  });
}

/** Shorthand — respond with JSON for any fetch call. */
function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Shared fetch mock state ───────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── isSemanticCacheEnabled ────────────────────────────────────────────────────

describe("isSemanticCacheEnabled", () => {
  it("returns false by default", () => {
    const prev = process.env.SEMANTIC_CACHE_ENABLED;
    delete process.env.SEMANTIC_CACHE_ENABLED;
    expect(isSemanticCacheEnabled()).toBe(false);
    if (prev !== undefined) {
      process.env.SEMANTIC_CACHE_ENABLED = prev;
    }
  });

  it("returns true when set to 'true'", () => {
    process.env.SEMANTIC_CACHE_ENABLED = "true";
    expect(isSemanticCacheEnabled()).toBe(true);
    delete process.env.SEMANTIC_CACHE_ENABLED;
  });

  it("returns true when set to '1'", () => {
    process.env.SEMANTIC_CACHE_ENABLED = "1";
    expect(isSemanticCacheEnabled()).toBe(true);
    delete process.env.SEMANTIC_CACHE_ENABLED;
  });

  it("returns false for other values", () => {
    process.env.SEMANTIC_CACHE_ENABLED = "yes";
    expect(isSemanticCacheEnabled()).toBe(false);
    delete process.env.SEMANTIC_CACHE_ENABLED;
  });
});

// ── resolveSemanticCacheThreshold ─────────────────────────────────────────────

describe("resolveSemanticCacheThreshold", () => {
  it("returns 0.92 by default", () => {
    delete process.env.CACHE_SIMILARITY_THRESHOLD;
    expect(resolveSemanticCacheThreshold()).toBe(0.92);
  });

  it("parses custom float", () => {
    process.env.CACHE_SIMILARITY_THRESHOLD = "0.7";
    expect(resolveSemanticCacheThreshold()).toBe(0.7);
    delete process.env.CACHE_SIMILARITY_THRESHOLD;
  });

  it("ignores invalid value and falls back to default", () => {
    process.env.CACHE_SIMILARITY_THRESHOLD = "banana";
    expect(resolveSemanticCacheThreshold()).toBe(0.92);
    delete process.env.CACHE_SIMILARITY_THRESHOLD;
  });

  it("ignores out-of-range values", () => {
    process.env.CACHE_SIMILARITY_THRESHOLD = "1.5";
    expect(resolveSemanticCacheThreshold()).toBe(0.92);
    delete process.env.CACHE_SIMILARITY_THRESHOLD;
  });
});

// ── QdrantSemanticCache.isEnabled ─────────────────────────────────────────────

describe("QdrantSemanticCache.isEnabled", () => {
  it("mirrors isSemanticCacheEnabled()", () => {
    delete process.env.SEMANTIC_CACHE_ENABLED;
    expect(makeCache().isEnabled()).toBe(false);
    process.env.SEMANTIC_CACHE_ENABLED = "true";
    expect(makeCache().isEnabled()).toBe(true);
    delete process.env.SEMANTIC_CACHE_ENABLED;
  });
});

// ── ensureCollection ─────────────────────────────────────────────────────────

function mockCollectionsListEmpty() {
  fetchMock.mockResolvedValueOnce(respondJson({ result: { collections: [] } }));
}

function mockCollectionCreate() {
  fetchMock.mockResolvedValueOnce(respondJson({ result: true }));
}

function mockCollectionsListExists(name: string) {
  fetchMock.mockResolvedValueOnce(respondJson({ result: { collections: [{ name }] } }));
}

// ── get — cache hit above threshold ──────────────────────────────────────────

describe("QdrantSemanticCache.get — cache hit", () => {
  it("returns cached response when score >= threshold", async () => {
    const cache = makeCache({ threshold: 0.85 });
    // 1. GET /collections — collection exists
    mockCollectionsListExists("llm_cache");
    // 2. POST /points/search — score 0.95 (above threshold)
    fetchMock.mockResolvedValueOnce(
      respondJson({
        result: [{ id: "abc", score: 0.95, payload: { response: "cached reply" } }],
      }),
    );

    const result = await cache.get("hello world");
    expect(result).toBe("cached reply");
  });

  it("returns the response string verbatim", async () => {
    const cache = makeCache({ threshold: 0.8 });
    mockCollectionsListExists("llm_cache");
    fetchMock.mockResolvedValueOnce(
      respondJson({
        result: [{ id: "x", score: 0.99, payload: { response: "detailed\nanswer\nhere" } }],
      }),
    );
    expect(await cache.get("?")).toBe("detailed\nanswer\nhere");
  });
});

// ── get — cache miss (score below threshold) ──────────────────────────────────

describe("QdrantSemanticCache.get — miss below threshold", () => {
  it("returns null when search returns score below threshold", async () => {
    const cache = makeCache({ threshold: 0.85 });
    mockCollectionsListExists("llm_cache");
    // search result with score below threshold — Qdrant score_threshold param
    // already filters, but we also check in our code
    fetchMock.mockResolvedValueOnce(
      respondJson({ result: [] }), // empty result (filtered by Qdrant)
    );

    const result = await cache.get("something");
    expect(result).toBeNull();
  });

  it("returns null when score is exactly at threshold boundary (< threshold)", async () => {
    const cache = makeCache({ threshold: 0.85 });
    mockCollectionsListExists("llm_cache");
    // Our code checks score >= threshold, so 0.84 → miss
    fetchMock.mockResolvedValueOnce(
      respondJson({
        result: [{ id: "y", score: 0.84, payload: { response: "stale" } }],
      }),
    );
    expect(await cache.get("query")).toBeNull();
  });
});

// ── get — cache miss (no results) ────────────────────────────────────────────

describe("QdrantSemanticCache.get — cache miss (empty results)", () => {
  it("returns null when no search results", async () => {
    const cache = makeCache();
    mockCollectionsListExists("llm_cache");
    fetchMock.mockResolvedValueOnce(respondJson({ result: [] }));

    expect(await cache.get("new query")).toBeNull();
  });

  it("returns null on network error (fail-safe)", async () => {
    const cache = makeCache();
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    expect(await cache.get("query")).toBeNull();
  });
});

// ── set ───────────────────────────────────────────────────────────────────────

describe("QdrantSemanticCache.set", () => {
  it("creates collection, counts, then upserts", async () => {
    const cache = makeCache({ maxEntries: 100 });
    // ensureCollection: list (empty) → create
    mockCollectionsListEmpty();
    mockCollectionCreate();
    // evictIfNeeded: count
    fetchMock.mockResolvedValueOnce(respondJson({ result: { count: 10 } }));
    // upsert
    fetchMock.mockResolvedValueOnce(
      respondJson({ result: { operation_id: 1, status: "completed" } }),
    );

    await expect(cache.set("my prompt", "my response")).resolves.not.toThrow();
    // Check upsert was called with the right structure
    const upsertCall = fetchMock.mock.calls.find((c: Parameters<typeof fetch>) => {
      const u = c[0] as string;
      return u.includes("/points") && !u.includes("count");
    });
    expect(upsertCall).toBeDefined();
  });

  it("does not throw on fetch error (fail-safe)", async () => {
    const cache = makeCache();
    fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(cache.set("x", "y")).resolves.not.toThrow();
  });
});

// ── LRU eviction ──────────────────────────────────────────────────────────────

describe("QdrantSemanticCache LRU eviction", () => {
  it("triggers eviction when at max capacity", async () => {
    const cache = makeCache({ maxEntries: 5 });
    mockCollectionsListExists("llm_cache");
    // count returns 5 (at limit)
    fetchMock.mockResolvedValueOnce(respondJson({ result: { count: 5 } }));
    // scroll (for eviction): returns 1 old entry (10% of 5 rounded up = 1)
    fetchMock.mockResolvedValueOnce(respondJson({ result: { points: [{ id: "old-1" }] } }));
    // delete
    fetchMock.mockResolvedValueOnce(respondJson({ result: true }));
    // upsert
    fetchMock.mockResolvedValueOnce(respondJson({ result: { status: "completed" } }));

    await cache.set("new prompt", "new response");

    const calls = fetchMock.mock.calls.map((c: Parameters<typeof fetch>) => c[0] as string);
    expect(calls.some((url: string) => url.includes("/points/scroll"))).toBe(true);
    expect(calls.some((url: string) => url.includes("/points/delete"))).toBe(true);
  });

  it("skips eviction when below max capacity", async () => {
    const cache = makeCache({ maxEntries: 1000 });
    mockCollectionsListExists("llm_cache");
    // count well below limit
    fetchMock.mockResolvedValueOnce(respondJson({ result: { count: 10 } }));
    // upsert
    fetchMock.mockResolvedValueOnce(respondJson({ result: { status: "completed" } }));

    await cache.set("q", "r");

    const calls = fetchMock.mock.calls.map((c: Parameters<typeof fetch>) => c[0] as string);
    expect(calls.some((url: string) => url.includes("/points/scroll"))).toBe(false);
  });
});

// ── createOpenAiEmbeddingFn ───────────────────────────────────────────────────

describe("createOpenAiEmbeddingFn", () => {
  it("calls OpenAI embeddings API and returns vector", async () => {
    const vec = [0.1, 0.2, 0.3];
    fetchMock.mockResolvedValueOnce(respondJson({ data: [{ embedding: vec }] }));

    const embed = createOpenAiEmbeddingFn({ apiKey: "sk-test" });
    const result = await embed("hello");
    expect(result).toEqual(vec);
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain("openai.com");
  });

  it("throws on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad api key", { status: 401 }));
    const embed = createOpenAiEmbeddingFn({ apiKey: "bad" });
    await expect(embed("hello")).rejects.toThrow("OpenAI embeddings failed");
  });
});

// ── resolveDefaultSemanticCache ───────────────────────────────────────────────

describe("resolveDefaultSemanticCache", () => {
  afterEach(() => {
    delete process.env.SEMANTIC_CACHE_ENABLED;
    delete process.env.QDRANT_URL;
    delete process.env.OPENAI_API_KEY;
  });

  it("returns null when cache disabled", () => {
    expect(resolveDefaultSemanticCache()).toBeNull();
  });

  it("returns null when QDRANT_URL missing", () => {
    process.env.SEMANTIC_CACHE_ENABLED = "true";
    expect(resolveDefaultSemanticCache()).toBeNull();
  });

  it("returns null when OPENAI_API_KEY missing", () => {
    process.env.SEMANTIC_CACHE_ENABLED = "true";
    process.env.QDRANT_URL = "http://localhost:6333";
    expect(resolveDefaultSemanticCache()).toBeNull();
  });

  it("returns a QdrantSemanticCache when fully configured", () => {
    process.env.SEMANTIC_CACHE_ENABLED = "true";
    process.env.QDRANT_URL = "http://localhost:6333";
    process.env.OPENAI_API_KEY = "sk-test";
    const cache = resolveDefaultSemanticCache();
    expect(cache).toBeInstanceOf(QdrantSemanticCache);
  });
});
