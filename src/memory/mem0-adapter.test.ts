import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Mem0Adapter, resolveMem0Config } from "./mem0-adapter.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function mockFetchOk(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

function mockFetchError(status: number, text = "Error") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(text),
    }),
  );
}

function mockFetchNetworkError() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
}

function makeAdapter() {
  return new Mem0Adapter({
    apiUrl: "http://localhost:8888",
    apiKey: "test-key",
    qdrantCollection: "test_memories",
    embedderModel: "text-embedding-3-small",
    llmModel: "gpt-4o-mini",
    topK: 5,
  });
}

// ── resolveMem0Config ─────────────────────────────────────────────────────────

describe("resolveMem0Config", () => {
  afterEach(() => {
    ["MEM0_API_URL", "MEM0_API_KEY", "MEM0_COLLECTION", "MEM0_EMBEDDER", "MEM0_LLM_MODEL", "MEM0_TOP_K"].forEach((k) =>
      setEnv(k, undefined),
    );
  });

  it("returns defaults when env vars unset", () => {
    const cfg = resolveMem0Config();
    expect(cfg.apiUrl).toBe("http://localhost:8888");
    expect(cfg.qdrantCollection).toBe("mem0_memories");
    expect(cfg.embedderModel).toBe("text-embedding-3-small");
    expect(cfg.llmModel).toBe("gpt-4o-mini");
    expect(cfg.topK).toBe(5);
    expect(cfg.apiKey).toBeUndefined();
  });

  it("reads from env vars", () => {
    setEnv("MEM0_API_URL", "http://my-mem0:9000/");
    setEnv("MEM0_API_KEY", "secret");
    setEnv("MEM0_COLLECTION", "my_col");
    setEnv("MEM0_TOP_K", "10");
    const cfg = resolveMem0Config();
    expect(cfg.apiUrl).toBe("http://my-mem0:9000");  // trailing slash stripped
    expect(cfg.apiKey).toBe("secret");
    expect(cfg.qdrantCollection).toBe("my_col");
    expect(cfg.topK).toBe(10);
  });

  it("falls back to default topK for invalid value", () => {
    setEnv("MEM0_TOP_K", "banana");
    expect(resolveMem0Config().topK).toBe(5);
  });
});

// ── Mem0Adapter.search ────────────────────────────────────────────────────────

describe("Mem0Adapter.search", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns results on success", async () => {
    mockFetchOk({ results: [{ id: "1", memory: "user likes cats", userId: "telegram:123" }] });
    const adapter = makeAdapter();
    const results = await adapter.search("what does user like?", "telegram:123");
    expect(results).toHaveLength(1);
    expect(results[0].memory).toBe("user likes cats");
  });

  it("returns empty array on HTTP error", async () => {
    mockFetchError(500, "Internal error");
    const adapter = makeAdapter();
    const results = await adapter.search("query", "telegram:123");
    expect(results).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    mockFetchNetworkError();
    const adapter = makeAdapter();
    const results = await adapter.search("query", "telegram:123");
    expect(results).toEqual([]);
  });

  it("handles 'memories' key as alternative to 'results'", async () => {
    mockFetchOk({ memories: [{ id: "2", memory: "user speaks French", userId: "slack:U123" }] });
    const adapter = makeAdapter();
    const results = await adapter.search("language", "slack:U123");
    expect(results[0].memory).toBe("user speaks French");
  });

  it("never throws even if fetch crashes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => { throw new Error("crash"); }));
    const adapter = makeAdapter();
    await expect(adapter.search("q", "u")).resolves.toEqual([]);
    vi.restoreAllMocks();
  });
});

// ── Mem0Adapter.add ───────────────────────────────────────────────────────────

describe("Mem0Adapter.add", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves without throwing on success", async () => {
    mockFetchOk({ ok: true });
    const adapter = makeAdapter();
    await expect(adapter.add([{ role: "user", content: "hello" }], "whatsapp:+1555")).resolves.toBeUndefined();
  });

  it("never throws on HTTP error", async () => {
    mockFetchError(422, "Validation error");
    const adapter = makeAdapter();
    await expect(adapter.add([{ role: "user", content: "hi" }], "whatsapp:+1555")).resolves.toBeUndefined();
  });

  it("never throws on network error", async () => {
    mockFetchNetworkError();
    const adapter = makeAdapter();
    await expect(adapter.add([], "u")).resolves.toBeUndefined();
  });

  it("never throws when fetch crashes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => { throw new Error("crash"); }));
    const adapter = makeAdapter();
    await expect(adapter.add([{ role: "user", content: "test" }], "x")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});

// ── Mem0Adapter.ping ──────────────────────────────────────────────────────────

describe("Mem0Adapter.ping", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true when server is healthy", async () => {
    mockFetchOk({ status: "ok" });
    const adapter = makeAdapter();
    expect(await adapter.ping()).toBe(true);
  });

  it("returns false on HTTP error", async () => {
    mockFetchError(503, "unavailable");
    const adapter = makeAdapter();
    expect(await adapter.ping()).toBe(false);
  });

  it("returns false on network error", async () => {
    mockFetchNetworkError();
    const adapter = makeAdapter();
    expect(await adapter.ping()).toBe(false);
  });
});

// ── userId cross-channel convention ──────────────────────────────────────────

describe("userId cross-channel convention", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes userId verbatim to search", async () => {
    mockFetchOk({ results: [] });
    const adapter = makeAdapter();
    await adapter.search("query", "telegram:123456");
    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      user_id: string;
    };
    expect(body.user_id).toBe("telegram:123456");
  });

  it("passes userId verbatim to add", async () => {
    mockFetchOk({ ok: true });
    const adapter = makeAdapter();
    await adapter.add([{ role: "user", content: "hi" }], "whatsapp:+15551234");
    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      user_id: string;
    };
    expect(body.user_id).toBe("whatsapp:+15551234");
  });
});
