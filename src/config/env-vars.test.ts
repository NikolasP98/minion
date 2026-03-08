import { describe, expect, it } from "vitest";
import { resolveEnvVar, resolveEnvInt, resolveEnvBool } from "./env-vars.js";

describe("resolveEnvVar", () => {
  it("returns MINION_ prefixed value first", () => {
    const env = {
      MINION_GATEWAY_PORT: "1111",
      OPENCLAW_GATEWAY_PORT: "2222",
    };
    expect(resolveEnvVar("GATEWAY_PORT", env)).toBe("1111");
  });

  it("falls back to OPENCLAW_ when MINION_ is missing", () => {
    const env = { OPENCLAW_GATEWAY_PORT: "2222" };
    expect(resolveEnvVar("GATEWAY_PORT", env)).toBe("2222");
  });

  it("falls back to CLAWDBOT_ when earlier prefixes missing", () => {
    const env = { CLAWDBOT_STATE_DIR: "/tmp/test" };
    expect(resolveEnvVar("STATE_DIR", env)).toBe("/tmp/test");
  });

  it("falls back to MINIONBOT_ as last resort", () => {
    const env = { MINIONBOT_STATE_DIR: "/tmp/last" };
    expect(resolveEnvVar("STATE_DIR", env)).toBe("/tmp/last");
  });

  it("returns undefined when no prefix matches", () => {
    expect(resolveEnvVar("GATEWAY_PORT", {})).toBeUndefined();
  });

  it("skips empty and whitespace-only values", () => {
    const env = {
      MINION_GATEWAY_PORT: "  ",
      OPENCLAW_GATEWAY_PORT: "3333",
    };
    expect(resolveEnvVar("GATEWAY_PORT", env)).toBe("3333");
  });

  it("trims whitespace from values", () => {
    const env = { MINION_STATE_DIR: "  /tmp/dir  " };
    expect(resolveEnvVar("STATE_DIR", env)).toBe("/tmp/dir");
  });
});

describe("resolveEnvInt", () => {
  it("parses valid integer", () => {
    const env = { MINION_GATEWAY_PORT: "18789" };
    expect(resolveEnvInt("GATEWAY_PORT", 0, env)).toBe(18789);
  });

  it("returns fallback for non-numeric value", () => {
    const env = { MINION_GATEWAY_PORT: "abc" };
    expect(resolveEnvInt("GATEWAY_PORT", 9999, env)).toBe(9999);
  });

  it("returns fallback when missing", () => {
    expect(resolveEnvInt("GATEWAY_PORT", 18789, {})).toBe(18789);
  });
});

describe("resolveEnvBool", () => {
  it("recognizes truthy values", () => {
    expect(resolveEnvBool("SKIP_CRON", false, { MINION_SKIP_CRON: "1" })).toBe(true);
    expect(resolveEnvBool("SKIP_CRON", false, { MINION_SKIP_CRON: "true" })).toBe(true);
    expect(resolveEnvBool("SKIP_CRON", false, { MINION_SKIP_CRON: "YES" })).toBe(true);
  });

  it("treats other values as falsy", () => {
    expect(resolveEnvBool("SKIP_CRON", true, { MINION_SKIP_CRON: "0" })).toBe(false);
    expect(resolveEnvBool("SKIP_CRON", true, { MINION_SKIP_CRON: "no" })).toBe(false);
  });

  it("returns fallback when missing", () => {
    expect(resolveEnvBool("SKIP_CRON", false, {})).toBe(false);
    expect(resolveEnvBool("SKIP_CRON", true, {})).toBe(true);
  });
});
