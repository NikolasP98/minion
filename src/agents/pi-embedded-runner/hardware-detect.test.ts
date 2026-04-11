import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totalmem } from "node:os";

import {
  checkRamGb,
  isLocalModelCapable,
  isPrivacyModeEnabled,
  MIN_LOCAL_RAM_GB,
  PRIVACY_MODE_DEFAULT_MODEL,
  PRIVACY_MODE_PROVIDER,
  resolvePrivacyModeOverride,
} from "./hardware-detect.js";

vi.mock("node:os", () => ({
  totalmem: vi.fn(() => 16 * 1_073_741_824), // default: 16 GB
}));

vi.mock("../../providers/registry.js", () => ({
  findByName: vi.fn((name: string) => {
    const localProviders = new Set(["ollama", "lmstudio", "vllm"]);
    // Mirror the real registry: return undefined for unknown providers, not { isLocal: false }
    if (!localProviders.has(name)) return undefined;
    return { isLocal: true };
  }),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function mockRamGb(gb: number) {
  vi.mocked(totalmem).mockReturnValue(gb * 1_073_741_824);
}

// ── checkRamGb ────────────────────────────────────────────────────────────────

describe("checkRamGb", () => {
  it("converts os.totalmem bytes to GB", () => {
    mockRamGb(32);
    expect(checkRamGb()).toBeCloseTo(32, 5);
  });

  it("returns 0 when os.totalmem throws", () => {
    vi.mocked(totalmem).mockImplementation(() => {
      throw new Error("not available");
    });
    expect(checkRamGb()).toBe(0);
    mockRamGb(16); // restore
  });
});

// ── isLocalModelCapable ───────────────────────────────────────────────────────

describe("isLocalModelCapable", () => {
  it("returns true when RAM == 16 GB (minimum)", () => {
    mockRamGb(MIN_LOCAL_RAM_GB);
    expect(isLocalModelCapable()).toBe(true);
  });

  it("returns true when RAM > 16 GB (32 GB machine)", () => {
    mockRamGb(32);
    expect(isLocalModelCapable()).toBe(true);
  });

  it("returns false when RAM < 16 GB (8 GB machine)", () => {
    mockRamGb(8);
    expect(isLocalModelCapable()).toBe(false);
  });

  it("returns false when RAM is 0 (error fallback)", () => {
    mockRamGb(0);
    expect(isLocalModelCapable()).toBe(false);
  });
});

// ── isPrivacyModeEnabled ──────────────────────────────────────────────────────

describe("isPrivacyModeEnabled", () => {
  afterEach(() => setEnv("MINION_PRIVACY_MODE", undefined));

  it("returns false when unset", () => {
    setEnv("MINION_PRIVACY_MODE", undefined);
    expect(isPrivacyModeEnabled()).toBe(false);
  });

  it("returns true for 'true'", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    expect(isPrivacyModeEnabled()).toBe(true);
  });

  it("returns true for '1'", () => {
    setEnv("MINION_PRIVACY_MODE", "1");
    expect(isPrivacyModeEnabled()).toBe(true);
  });

  it("returns false for 'false'", () => {
    setEnv("MINION_PRIVACY_MODE", "false");
    expect(isPrivacyModeEnabled()).toBe(false);
  });

  it("returns false for arbitrary string", () => {
    setEnv("MINION_PRIVACY_MODE", "yes");
    expect(isPrivacyModeEnabled()).toBe(false);
  });
});

// ── resolvePrivacyModeOverride ────────────────────────────────────────────────

describe("resolvePrivacyModeOverride", () => {
  beforeEach(() => {
    setEnv("MINION_PRIVACY_MODE", undefined);
    setEnv("MINION_LOCAL_MODEL", undefined);
    mockRamGb(16);
  });

  afterEach(() => {
    setEnv("MINION_PRIVACY_MODE", undefined);
    setEnv("MINION_LOCAL_MODEL", undefined);
  });

  it("returns null when privacy mode is off", () => {
    setEnv("MINION_PRIVACY_MODE", undefined);
    expect(resolvePrivacyModeOverride("anthropic", "claude-sonnet-4")).toBeNull();
  });

  it("returns local override when privacy mode is on and hardware passes (16 GB)", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    mockRamGb(16);
    const result = resolvePrivacyModeOverride("anthropic", "claude-sonnet-4");
    expect(result).toEqual({
      provider: PRIVACY_MODE_PROVIDER,
      modelId: PRIVACY_MODE_DEFAULT_MODEL,
    });
  });

  it("returns null (with warning) when privacy mode is on but hardware fails (8 GB)", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    mockRamGb(8);
    expect(resolvePrivacyModeOverride("anthropic", "claude-sonnet-4")).toBeNull();
  });

  it("respects MINION_LOCAL_MODEL override", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    setEnv("MINION_LOCAL_MODEL", "llama3:70b");
    mockRamGb(32);
    const result = resolvePrivacyModeOverride("openai", "gpt-4o");
    expect(result?.modelId).toBe("llama3:70b");
  });

  it("returns null when already on Ollama (no double-override)", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    mockRamGb(32);
    expect(resolvePrivacyModeOverride("ollama", "phi-4")).toBeNull();
  });

  it("returns null when already on lmstudio (already local)", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    mockRamGb(32);
    expect(resolvePrivacyModeOverride("lmstudio", "phi-4")).toBeNull();
  });

  it("returns null when already on vllm (already local)", () => {
    setEnv("MINION_PRIVACY_MODE", "true");
    mockRamGb(32);
    expect(resolvePrivacyModeOverride("vllm", "llama3:8b")).toBeNull();
  });
});
