import { describe, it, expect } from "vitest";
import {
  normalizeWeixinTarget,
  formatWeixinTarget,
  looksLikeWeixinId,
  resolveWeixinTargetType,
} from "./targets.js";

describe("normalizeWeixinTarget", () => {
  it("should strip weixin: prefix", () => {
    expect(normalizeWeixinTarget("weixin:123456")).toBe("123456");
  });

  it("should strip wechat: prefix", () => {
    expect(normalizeWeixinTarget("wechat:123456")).toBe("123456");
  });

  it("should strip user: prefix", () => {
    expect(normalizeWeixinTarget("user:123456")).toBe("123456");
  });

  it("should strip group: prefix", () => {
    expect(normalizeWeixinTarget("group:g789")).toBe("g789");
  });

  it("should handle case-insensitive prefixes", () => {
    expect(normalizeWeixinTarget("WEIXIN:123456")).toBe("123456");
    expect(normalizeWeixinTarget("WeChat:123456")).toBe("123456");
    expect(normalizeWeixinTarget("USER:123456")).toBe("123456");
    expect(normalizeWeixinTarget("GROUP:g789")).toBe("g789");
  });

  it("should return bare strings as-is", () => {
    expect(normalizeWeixinTarget("123456")).toBe("123456");
  });

  it("should return null for empty strings", () => {
    expect(normalizeWeixinTarget("")).toBeNull();
    expect(normalizeWeixinTarget("  ")).toBeNull();
  });

  it("should return null when prefix has no value", () => {
    expect(normalizeWeixinTarget("weixin:")).toBeNull();
    expect(normalizeWeixinTarget("user:  ")).toBeNull();
  });

  it("should trim whitespace", () => {
    expect(normalizeWeixinTarget("  weixin:123456  ")).toBe("123456");
  });
});

describe("formatWeixinTarget", () => {
  it("should format user targets with user: prefix", () => {
    expect(formatWeixinTarget("123456")).toBe("user:123456");
  });

  it("should format group targets with group: prefix", () => {
    expect(formatWeixinTarget("g789", true)).toBe("group:g789");
  });

  it("should default to user: for non-group", () => {
    expect(formatWeixinTarget("123456", false)).toBe("user:123456");
  });
});

describe("looksLikeWeixinId", () => {
  it("should match weixin: prefixed strings", () => {
    expect(looksLikeWeixinId("weixin:123456")).toBe(true);
  });

  it("should match wechat: prefixed strings", () => {
    expect(looksLikeWeixinId("wechat:123456")).toBe(true);
  });

  it("should match user: prefixed strings", () => {
    expect(looksLikeWeixinId("user:123456")).toBe(true);
  });

  it("should match group: prefixed strings", () => {
    expect(looksLikeWeixinId("group:g789")).toBe(true);
  });

  it("should match numeric UINs (6+ digits)", () => {
    expect(looksLikeWeixinId("123456")).toBe(true);
    expect(looksLikeWeixinId("1234567890")).toBe(true);
  });

  it("should not match short numeric strings", () => {
    expect(looksLikeWeixinId("12345")).toBe(false);
  });

  it("should not match non-numeric, non-prefixed strings", () => {
    expect(looksLikeWeixinId("alice")).toBe(false);
  });

  it("should not match empty strings", () => {
    expect(looksLikeWeixinId("")).toBe(false);
    expect(looksLikeWeixinId("  ")).toBe(false);
  });
});

describe("resolveWeixinTargetType", () => {
  it("should return 'group' for group: prefix", () => {
    expect(resolveWeixinTargetType("group:g789")).toBe("group");
  });

  it("should return 'user' for user: prefix", () => {
    expect(resolveWeixinTargetType("user:123456")).toBe("user");
  });

  it("should default to 'user' for bare IDs", () => {
    expect(resolveWeixinTargetType("123456")).toBe("user");
  });
});
