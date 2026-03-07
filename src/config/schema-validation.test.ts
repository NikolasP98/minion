import { describe, expect, it } from "vitest";
import { formatValidationErrors, validateConfigAtStartup } from "./schema-validation.js";

describe("validateConfigAtStartup", () => {
  it("accepts an empty config", () => {
    const result = validateConfigAtStartup({});
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a minimal valid config", () => {
    const result = validateConfigAtStartup({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4" },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const result = validateConfigAtStartup({
      totallyInvalid: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].code).toBe("unrecognized_keys");
  });

  it("rejects invalid nested types", () => {
    const result = validateConfigAtStartup({
      agents: {
        defaults: {
          model: {
            primary: 42, // should be string
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("model"))).toBe(true);
  });

  it("collects multiple errors", () => {
    const result = validateConfigAtStartup({
      unknownKey1: true,
      unknownKey2: true,
    });
    expect(result.valid).toBe(false);
    // Strict mode reports all unrecognized keys in one error
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("never throws on any input", () => {
    expect(() => validateConfigAtStartup(null)).not.toThrow();
    expect(() => validateConfigAtStartup(undefined)).not.toThrow();
    expect(() => validateConfigAtStartup("string")).not.toThrow();
    expect(() => validateConfigAtStartup(42)).not.toThrow();
    expect(() => validateConfigAtStartup([])).not.toThrow();
  });

  it("returns errors for null input", () => {
    const result = validateConfigAtStartup(null);
    expect(result.valid).toBe(false);
  });

  it("rejects tailscale.mode=serve when bind is not loopback", () => {
    const result = validateConfigAtStartup({
      gateway: {
        bind: "lan",
        tailscale: { mode: "serve" },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('tailscale.mode="serve"'))).toBe(true);
  });

  it("accepts tailscale.mode=serve with bind=loopback", () => {
    const result = validateConfigAtStartup({
      gateway: {
        bind: "loopback",
        tailscale: { mode: "serve" },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts tailscale.mode=serve with bind=auto", () => {
    const result = validateConfigAtStartup({
      gateway: {
        bind: "auto",
        tailscale: { mode: "serve" },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("validates logging level options", () => {
    const valid = validateConfigAtStartup({
      logging: { level: "debug" },
    });
    expect(valid.valid).toBe(true);

    const invalid = validateConfigAtStartup({
      logging: { level: "super-verbose" },
    });
    expect(invalid.valid).toBe(false);
  });
});

describe("formatValidationErrors", () => {
  it("returns 'No errors' for empty array", () => {
    expect(formatValidationErrors([])).toBe("No errors");
  });

  it("formats errors with numbering", () => {
    const formatted = formatValidationErrors([
      { path: "agents.defaults.model.primary", message: "Expected string", code: "invalid_type" },
      { path: "", message: "Unrecognized key", code: "unrecognized_keys" },
    ]);
    expect(formatted).toContain("1.");
    expect(formatted).toContain("2.");
    expect(formatted).toContain("agents.defaults.model.primary");
    expect(formatted).toContain("(root)");
  });
});
