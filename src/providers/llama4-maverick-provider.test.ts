import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Llama4MaverickProvider,
  isLlama4MaverickEnabled,
  resolveDefaultLlama4Provider,
  META_AI_API_BASE,
  GROQ_API_BASE,
  LLAMA4_MAVERICK_MODEL,
  GROQ_LLAMA4_MODEL,
} from "./llama4-maverick-provider.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function mockFetchOk(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content } }],
        }),
      text: () => Promise.resolve(content),
    }),
  );
}

function mockFetchError(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve({ error: { message: body } }),
    }),
  );
}

// ── isLlama4MaverickEnabled ───────────────────────────────────────────────────

describe("isLlama4MaverickEnabled", () => {
  afterEach(() => setEnv("LLAMA4_MAVERICK_ENABLED", undefined));

  it("returns false when unset", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", undefined);
    expect(isLlama4MaverickEnabled()).toBe(false);
  });

  it("returns true for 'true'", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", "true");
    expect(isLlama4MaverickEnabled()).toBe(true);
  });

  it("returns true for '1'", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", "1");
    expect(isLlama4MaverickEnabled()).toBe(true);
  });

  it("returns false for 'false'", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", "false");
    expect(isLlama4MaverickEnabled()).toBe(false);
  });
});

// ── Llama4MaverickProvider constructor ───────────────────────────────────────

describe("Llama4MaverickProvider constructor", () => {
  beforeEach(() => {
    setEnv("META_AI_API_KEY", undefined);
    setEnv("GROQ_API_KEY", undefined);
  });

  afterEach(() => {
    setEnv("META_AI_API_KEY", undefined);
    setEnv("GROQ_API_KEY", undefined);
  });

  it("uses Meta AI endpoint when META_AI_API_KEY is set", () => {
    setEnv("META_AI_API_KEY", "meta-key-123");
    const p = new Llama4MaverickProvider();
    expect((p as unknown as { apiBase: string }).apiBase).toBe(META_AI_API_BASE);
    expect((p as unknown as { model: string }).model).toBe(LLAMA4_MAVERICK_MODEL);
  });

  it("falls back to Groq when only GROQ_API_KEY is set", () => {
    setEnv("GROQ_API_KEY", "groq-key-456");
    const p = new Llama4MaverickProvider();
    expect((p as unknown as { apiBase: string }).apiBase).toBe(GROQ_API_BASE);
    expect((p as unknown as { model: string }).model).toBe(GROQ_LLAMA4_MODEL);
  });

  it("throws when no API key is available", () => {
    expect(() => new Llama4MaverickProvider()).toThrow(/META_AI_API_KEY or GROQ_API_KEY/);
  });

  it("accepts explicit apiKey override", () => {
    const p = new Llama4MaverickProvider({ apiKey: "custom-key" });
    expect((p as unknown as { apiKey: string }).apiKey).toBe("custom-key");
  });
});

// ── complete (text reasoning) ─────────────────────────────────────────────────

describe("Llama4MaverickProvider.complete", () => {
  beforeEach(() => setEnv("META_AI_API_KEY", "test-meta-key"));
  afterEach(() => {
    setEnv("META_AI_API_KEY", undefined);
    vi.restoreAllMocks();
  });

  it("returns assistant text on success", async () => {
    mockFetchOk("Paris is the capital of France.");
    const p = new Llama4MaverickProvider();
    const result = await p.complete("What is the capital of France?");
    expect(result).toBe("Paris is the capital of France.");
  });

  it("includes system prompt when provided", async () => {
    mockFetchOk("42");
    const p = new Llama4MaverickProvider();
    await p.complete("What is the answer?", { system: "You are a helpful assistant." });
    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
  });

  it("throws on HTTP error", async () => {
    mockFetchError(401, "Unauthorized");
    const p = new Llama4MaverickProvider();
    await expect(p.complete("hello")).rejects.toThrow("HTTP 401");
  });
});

// ── processImage (vision) ─────────────────────────────────────────────────────

describe("Llama4MaverickProvider.processImage", () => {
  beforeEach(() => setEnv("META_AI_API_KEY", "test-meta-key"));
  afterEach(() => {
    setEnv("META_AI_API_KEY", undefined);
    vi.restoreAllMocks();
  });

  it("returns image description", async () => {
    mockFetchOk("A golden retriever sitting on grass.");
    const p = new Llama4MaverickProvider();
    const result = await p.processImage("base64encodeddata", "Describe the image.");
    expect(result).toBe("A golden retriever sitting on grass.");
  });

  it("prepends data URL when base64 does not start with 'data:'", async () => {
    mockFetchOk("A cat.");
    const p = new Llama4MaverickProvider();
    await p.processImage("rawbase64data", "What is in the image?");
    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imageContent = body.messages[0].content.find((c) => c.type === "image_url");
    expect(imageContent?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("passes through existing data URL unchanged", async () => {
    mockFetchOk("A dog.");
    const p = new Llama4MaverickProvider();
    await p.processImage("data:image/png;base64,abc123", "Describe.");
    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imageContent = body.messages[0].content.find((c) => c.type === "image_url");
    expect(imageContent?.image_url?.url).toBe("data:image/png;base64,abc123");
  });
});

// ── resolveDefaultLlama4Provider ─────────────────────────────────────────────

describe("resolveDefaultLlama4Provider", () => {
  afterEach(() => {
    setEnv("LLAMA4_MAVERICK_ENABLED", undefined);
    setEnv("META_AI_API_KEY", undefined);
  });

  it("returns null when feature is disabled", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", "false");
    setEnv("META_AI_API_KEY", "some-key");
    expect(resolveDefaultLlama4Provider()).toBeNull();
  });

  it("returns null when enabled but no API key", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", "true");
    setEnv("META_AI_API_KEY", undefined);
    setEnv("GROQ_API_KEY", undefined);
    expect(resolveDefaultLlama4Provider()).toBeNull();
  });

  it("returns provider instance when enabled and key is available", () => {
    setEnv("LLAMA4_MAVERICK_ENABLED", "true");
    setEnv("META_AI_API_KEY", "meta-key");
    expect(resolveDefaultLlama4Provider()).toBeInstanceOf(Llama4MaverickProvider);
  });
});
