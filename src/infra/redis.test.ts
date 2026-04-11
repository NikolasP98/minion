import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the optional Redis client factory.
 * No live Redis instance required — tests only cover factory behavior.
 */
describe("Redis client factory", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
  });

  it("returns null when REDIS_URL is not set", async () => {
    delete process.env.REDIS_URL;
    const { getRedisClient } = await import("./redis.js");
    const c = getRedisClient();
    expect(c).toBeNull();
  });

  it("returns null subscriber when REDIS_URL is not set", async () => {
    delete process.env.REDIS_URL;
    const { getRedisSubscriber } = await import("./redis.js");
    const s = getRedisSubscriber();
    expect(s).toBeNull();
  });

  it("returns a Redis instance when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedisClient, __resetRedisForTest } = await import("./redis.js");
    const c = getRedisClient();
    expect(c).not.toBeNull();
    __resetRedisForTest();
  });

  it("returns a separate subscriber instance when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedisClient, getRedisSubscriber, __resetRedisForTest } = await import("./redis.js");
    const c = getRedisClient();
    const s = getRedisSubscriber();
    expect(c).not.toBeNull();
    expect(s).not.toBeNull();
    expect(c).not.toBe(s); // must be separate connections for pub/sub
    __resetRedisForTest();
  });
});

describe("mkKey", () => {
  it("builds namespaced keys", async () => {
    const { mkKey } = await import("./redis.js");
    expect(mkKey("mesh", "run", "abc-123")).toBe("minion:mesh:run:abc-123");
    expect(mkKey("agent", "lifecycle")).toBe("minion:agent:lifecycle");
  });
});

describe("rSerialise / rDeserialise", () => {
  it("round-trips a value", async () => {
    const { rSerialise, rDeserialise } = await import("./redis.js");
    const val = { runId: "x", status: "ok", ts: 1234 };
    expect(rDeserialise(rSerialise(val))).toEqual(val);
  });

  it("returns null for null input", async () => {
    const { rDeserialise } = await import("./redis.js");
    expect(rDeserialise(null)).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const { rDeserialise } = await import("./redis.js");
    expect(rDeserialise("{invalid}")).toBeNull();
  });
});
