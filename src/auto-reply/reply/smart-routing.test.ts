import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _sessionPinInternals,
  applyProfileBias,
  classifyMessage,
  clearAllSessionPins,
  FAST_CHAT_SYSTEM_PROMPT,
  getSessionPin,
  pinSession,
  readMemorySnapshot,
  routeAlwaysOrchestrator,
  routeMessage,
  unpinSession,
  type AgentOrchestratorConfig,
  type AgentRoutingConfig,
} from "./smart-routing.js";

// ── classifyMessage ──────────────────────────────────────────────────────────

describe("classifyMessage", () => {
  describe("simple messages", () => {
    const simpleCases = [
      ["", "empty string"],
      ["   ", "whitespace only"],
      ["hi", "greeting"],
      ["hey", "casual greeting"],
      ["hello", "hello"],
      ["good morning", "good morning"],
      ["how are you?", "how are you"],
      ["thanks", "thanks"],
      ["thank you", "thank you"],
      ["ok", "ok"],
      ["yes", "yes"],
      ["no", "no"],
      ["cool", "cool"],
      ["nice", "nice"],
      ["lol", "lol"],
      ["👍", "thumbs up emoji"],
      ["haha", "laughter"],
      ["what's up?", "whats up"],
      ["good night", "good night"],
      ["bye", "farewell"],
    ] as const;

    for (const [msg, label] of simpleCases) {
      it(`classifies "${label}" as simple`, () => {
        expect(classifyMessage(msg)).toBe("simple");
      });
    }
  });

  describe("complex messages", () => {
    const complexCases = [
      ["```typescript\nconst x = 1;\n```", "code block"],
      ["fix the bug in src/gateway/server.ts", "fix keyword + file path"],
      ["https://example.com/api/v2/users", "URL"],
      ["v2.3.1 is broken", "version number"],
      ["import { foo } from 'bar'", "import statement"],
      ["at Object.<anonymous> (/app/src/index.ts:42:10)", "stack trace"],
      ['{"name": "test", "value": 42}', "JSON structure"],
      ["cat file.txt | grep error", "shell pipe"],
      ["debug the authentication issue", "debug keyword"],
      ["create a new component for the dashboard", "create keyword"],
      ["build the Docker image and deploy", "build + deploy keywords"],
      ["refactor the provider registry", "refactor keyword"],
      ["implement smart routing for the gateway", "implement keyword"],
      ["configure the Ollama endpoint", "configure keyword"],
      ["/model claude-sonnet", "slash command"],
      ["/think high", "think directive"],
      ["First sentence. Second sentence. Third sentence. Fourth sentence.", "4+ sentences"],
      ["install the dependencies and run the tests", "install + test keywords"],
      ["migrate the database schema to v3", "migrate + schema keywords"],
      ["optimize the query performance", "optimize keyword"],
    ] as const;

    for (const [msg, label] of complexCases) {
      it(`classifies "${label}" as complex`, () => {
        expect(classifyMessage(msg)).toBe("complex");
      });
    }
  });

  describe("moderate messages", () => {
    const moderateCases = [
      ["go ahead", "affirmative confirmation"],
      ["do it", "do it confirmation"],
      ["proceed", "proceed confirmation"],
      ["yes please", "polite confirmation"],
      ["show me the logs", "show keyword"],
      ["find the config file", "find keyword"],
      ["search for that error message", "search keyword"],
      ["send an email to john", "send keyword"],
      ["what's the weather like?", "weather keyword"],
      ["set a reminder for 3pm", "reminder keyword"],
      ["translate this to Spanish", "translate keyword"],
    ] as const;

    for (const [msg, label] of moderateCases) {
      it(`classifies "${label}" as moderate`, () => {
        expect(classifyMessage(msg)).toBe("moderate");
      });
    }
  });

  describe("edge cases", () => {
    it("classifies long simple text as moderate", () => {
      const longSimple = "a".repeat(200);
      expect(classifyMessage(longSimple)).toBe("moderate");
    });

    it("respects custom maxSimpleLength", () => {
      const msg = "a".repeat(200);
      expect(classifyMessage(msg, { maxSimpleLength: 300 })).toBe("simple");
      expect(classifyMessage(msg, { maxSimpleLength: 100 })).toBe("moderate");
    });

    it("handles mixed language", () => {
      expect(classifyMessage("buenos días")).toBe("simple");
    });

    it("handles emoji-only messages", () => {
      expect(classifyMessage("😊")).toBe("simple");
    });

    it("treats complex patterns as complex even if short", () => {
      expect(classifyMessage("```code```")).toBe("complex");
    });

    it("does not false-positive on 'good' as complex", () => {
      // "good" is not in complex keywords
      expect(classifyMessage("good")).toBe("simple");
    });

    it("does not classify bare URL-less text with moderate words as complex", () => {
      expect(classifyMessage("show")).toBe("moderate");
    });
  });
});

// ── routeMessage ─────────────────────────────────────────────────────────────

describe("routeMessage", () => {
  const routing: AgentRoutingConfig = {
    enabled: true,
    fastModel: "ollama/qwen3:1.7b",
    localModel: "ollama/gemma3:12b",
    fastModelContextTokens: 4096,
  };

  it("returns undefined when routing is disabled", () => {
    expect(routeMessage({ message: "hi", routing: { enabled: false } })).toBeUndefined();
  });

  it("returns undefined when routing config is missing", () => {
    expect(routeMessage({ message: "hi" })).toBeUndefined();
  });

  it("routes simple messages to fast model with tools disabled", () => {
    const result = routeMessage({ message: "hey", routing });
    expect(result).toEqual({
      complexity: "simple",
      provider: "ollama",
      model: "qwen3:1.7b",
      disableTools: true,
      contextTokensCap: 4096,
      timeoutMs: 600_000,
    });
  });

  it("routes moderate messages to local model with tools enabled", () => {
    const result = routeMessage({ message: "show me the logs", routing });
    expect(result).toEqual({
      complexity: "moderate",
      provider: "ollama",
      model: "gemma3:12b",
      disableTools: false,
      timeoutMs: 600_000,
    });
  });

  it("routes complex messages to default (no model override)", () => {
    const result = routeMessage({
      message: "fix the bug in server.ts",
      routing,
    });
    expect(result).toEqual({
      complexity: "complex",
      disableTools: false,
    });
  });

  it("returns undefined for simple when no fast model configured", () => {
    const result = routeMessage({
      message: "hi",
      routing: { enabled: true },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for moderate when no local model configured", () => {
    const result = routeMessage({
      message: "show me the logs",
      routing: { enabled: true, fastModel: "ollama/small" },
    });
    expect(result).toBeUndefined();
  });

  it("uses default context token cap when not configured", () => {
    const result = routeMessage({
      message: "hi",
      routing: { enabled: true, fastModel: "ollama/small" },
    });
    expect(result?.contextTokensCap).toBe(4096);
  });

  it("uses custom context token cap", () => {
    const result = routeMessage({
      message: "hi",
      routing: { ...routing, fastModelContextTokens: 2048 },
    });
    expect(result?.contextTokensCap).toBe(2048);
  });
});

// ── FAST_CHAT_SYSTEM_PROMPT ──────────────────────────────────────────────────

describe("FAST_CHAT_SYSTEM_PROMPT", () => {
  it("contains tool prohibition", () => {
    expect(FAST_CHAT_SYSTEM_PROMPT).toContain("Do NOT output any JSON");
    expect(FAST_CHAT_SYSTEM_PROMPT).toContain("fast chat mode");
  });
});

// ── readMemorySnapshot ───────────────────────────────────────────────────────

describe("readMemorySnapshot", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join("/tmp", "smart-routing-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when file is missing", async () => {
    const result = await readMemorySnapshot(tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined when file is empty", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "state.md"), "");
    const result = await readMemorySnapshot(tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined when file is whitespace-only", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "state.md"), "   \n  \n  ");
    const result = await readMemorySnapshot(tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns snapshot with header for valid content", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "state.md"), "User prefers dark mode.");
    const result = await readMemorySnapshot(tmpDir);
    expect(result).toContain("## Current Memory State");
    expect(result).toContain("User prefers dark mode.");
  });

  it("truncates content exceeding 800 chars", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    const longContent = "x".repeat(1000);
    await fs.writeFile(path.join(memDir, "state.md"), longContent);
    const result = await readMemorySnapshot(tmpDir);
    expect(result).toBeDefined();
    expect(result).toContain("[...truncated]");
    // Header + 800 chars + truncation marker
    expect(result!.length).toBeLessThan(900);
  });

  it("preserves content at exactly 800 chars", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    const exactContent = "y".repeat(800);
    await fs.writeFile(path.join(memDir, "state.md"), exactContent);
    const result = await readMemorySnapshot(tmpDir);
    expect(result).toBeDefined();
    expect(result).toContain(exactContent);
    expect(result).not.toContain("[...truncated]");
  });
});

// ── Orchestrator dispatch ────────────────────────────────────────────────────

describe("orchestrator dispatch", () => {
  const routing: AgentRoutingConfig = {
    enabled: true,
    fastModel: "ollama/qwen3:1.7b",
    localModel: "ollama/gemma3:12b",
  };

  const orchestrator: AgentOrchestratorConfig = {
    enabled: true,
    model: "anthropic/claude-sonnet-4",
    strategy: "auto",
  };

  describe("auto strategy", () => {
    it("routes complex messages to orchestrator model", () => {
      const result = routeMessage({
        message: "refactor the authentication middleware to use JWT",
        routing,
        orchestrator,
      });
      expect(result).toBeDefined();
      expect(result!.orchestrated).toBe(true);
      expect(result!.provider).toBe("anthropic");
      expect(result!.model).toBe("claude-sonnet-4");
      expect(result!.resetModelAfterTurn).toBe(true);
    });

    it("routes simple messages to fast model (not orchestrator)", () => {
      const result = routeMessage({ message: "hey", routing, orchestrator });
      expect(result).toBeDefined();
      expect(result!.complexity).toBe("simple");
      expect(result!.orchestrated).toBeUndefined();
      expect(result!.provider).toBe("ollama");
    });

    it("routes moderate messages to local model (not orchestrator)", () => {
      const result = routeMessage({
        message: "show me the weather",
        routing,
        orchestrator,
      });
      expect(result).toBeDefined();
      expect(result!.complexity).toBe("moderate");
      expect(result!.orchestrated).toBeUndefined();
    });
  });

  describe("always strategy", () => {
    const alwaysOrch: AgentOrchestratorConfig = {
      ...orchestrator,
      strategy: "always",
    };

    it("routes ALL messages to orchestrator", () => {
      // Even simple messages go to orchestrator.
      const result = routeMessage({
        message: "hey",
        routing,
        orchestrator: alwaysOrch,
      });
      expect(result).toBeDefined();
      expect(result!.orchestrated).toBe(true);
      expect(result!.provider).toBe("anthropic");
      expect(result!.resetModelAfterTurn).toBe(true);
    });

    it("routes moderate messages to orchestrator", () => {
      const result = routeMessage({
        message: "show me the weather",
        routing,
        orchestrator: alwaysOrch,
      });
      expect(result!.orchestrated).toBe(true);
    });
  });

  describe("fallback-only strategy", () => {
    const fallbackOrch: AgentOrchestratorConfig = {
      ...orchestrator,
      strategy: "fallback-only",
    };

    it("routes complex messages to default (no orchestrator override)", () => {
      const result = routeMessage({
        message: "refactor the authentication middleware to use JWT",
        routing,
        orchestrator: fallbackOrch,
      });
      expect(result).toBeDefined();
      expect(result!.complexity).toBe("complex");
      expect(result!.orchestrated).toBeUndefined();
      expect(result!.provider).toBeUndefined();
    });

    it("routes simple messages to fast model normally", () => {
      const result = routeMessage({
        message: "hey",
        routing,
        orchestrator: fallbackOrch,
      });
      expect(result!.complexity).toBe("simple");
      expect(result!.provider).toBe("ollama");
    });
  });

  describe("orchestrator disabled or missing", () => {
    it("returns no orchestrator override when disabled", () => {
      const result = routeMessage({
        message: "refactor the auth module",
        routing,
        orchestrator: { enabled: false, model: "anthropic/claude-sonnet-4" },
      });
      expect(result!.orchestrated).toBeUndefined();
    });

    it("returns no orchestrator override when no model configured", () => {
      const result = routeMessage({
        message: "refactor the auth module",
        routing,
        orchestrator: { enabled: true },
      });
      expect(result!.orchestrated).toBeUndefined();
    });

    it("returns no orchestrator override when orchestrator is undefined", () => {
      const result = routeMessage({
        message: "refactor the auth module",
        routing,
      });
      expect(result!.orchestrated).toBeUndefined();
    });
  });

  describe("resetModelAfterTurn", () => {
    it("is true when orchestrator is used", () => {
      const result = routeMessage({
        message: "refactor the auth module",
        routing,
        orchestrator,
      });
      expect(result!.resetModelAfterTurn).toBe(true);
    });

    it("is undefined when orchestrator is not used", () => {
      const result = routeMessage({
        message: "hey",
        routing,
        orchestrator,
      });
      expect(result!.resetModelAfterTurn).toBeUndefined();
    });
  });
});

// ── applyProfileBias ──────────────────────────────────────────────────────────

describe("applyProfileBias", () => {
  it("balanced profile does not change complexity", () => {
    expect(applyProfileBias("simple", "balanced")).toBe("simple");
    expect(applyProfileBias("moderate", "balanced")).toBe("moderate");
    expect(applyProfileBias("complex", "balanced")).toBe("complex");
  });

  it("undefined profile behaves as balanced", () => {
    expect(applyProfileBias("moderate", undefined)).toBe("moderate");
  });

  it("cost-optimized downgrades tiers", () => {
    expect(applyProfileBias("simple", "cost-optimized")).toBe("simple");
    expect(applyProfileBias("moderate", "cost-optimized")).toBe("simple");
    expect(applyProfileBias("complex", "cost-optimized")).toBe("moderate");
  });

  it("quality-first upgrades tiers", () => {
    expect(applyProfileBias("simple", "quality-first")).toBe("moderate");
    expect(applyProfileBias("moderate", "quality-first")).toBe("complex");
    expect(applyProfileBias("complex", "quality-first")).toBe("complex");
  });

  it("local-only caps at moderate", () => {
    expect(applyProfileBias("simple", "local-only")).toBe("simple");
    expect(applyProfileBias("moderate", "local-only")).toBe("moderate");
    expect(applyProfileBias("complex", "local-only")).toBe("moderate");
  });
});

// ── Profile-aware routing ─────────────────────────────────────────────────────

describe("routeMessage with profiles", () => {
  const routing: AgentRoutingConfig = {
    enabled: true,
    fastModel: "ollama/qwen3:1.7b",
    localModel: "ollama/gemma3:12b",
  };

  it("cost-optimized routes moderate messages to fast model", () => {
    const result = routeMessage({
      message: "show me the logs",
      routing: { ...routing, profile: "cost-optimized" },
    });
    expect(result).toBeDefined();
    expect(result!.complexity).toBe("simple");
    expect(result!.model).toBe("qwen3:1.7b");
  });

  it("quality-first routes simple messages to local model", () => {
    const result = routeMessage({
      message: "hey",
      routing: { ...routing, profile: "quality-first" },
    });
    expect(result).toBeDefined();
    expect(result!.complexity).toBe("moderate");
    expect(result!.model).toBe("gemma3:12b");
  });

  it("local-only routes complex messages to local model (downgrades to moderate tier)", () => {
    const result = routeMessage({
      message: "refactor the auth module",
      routing: { ...routing, profile: "local-only" },
    });
    expect(result).toBeDefined();
    // local-only downgrades complex → moderate, routed to local model
    expect(result!.complexity).toBe("moderate");
    expect(result!.provider).toBe("ollama");
    expect(result!.model).toBe("gemma3:12b");
  });

  it("local-only skips orchestrator always-route", () => {
    const result = routeMessage({
      message: "hey",
      routing: { ...routing, profile: "local-only" },
      orchestrator: { enabled: true, model: "anthropic/claude-sonnet-4", strategy: "always" },
    });
    expect(result).toBeDefined();
    expect(result!.orchestrated).toBeUndefined();
    expect(result!.provider).toBe("ollama");
  });
});

describe("routeAlwaysOrchestrator", () => {
  it("returns route when strategy is always and enabled", () => {
    const result = routeAlwaysOrchestrator({
      enabled: true,
      model: "anthropic/claude-sonnet-4",
      strategy: "always",
    });
    expect(result).toBeDefined();
    expect(result!.provider).toBe("anthropic");
    expect(result!.orchestrated).toBe(true);
  });

  it("returns undefined when strategy is auto", () => {
    expect(
      routeAlwaysOrchestrator({
        enabled: true,
        model: "anthropic/claude-sonnet-4",
        strategy: "auto",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when disabled", () => {
    expect(
      routeAlwaysOrchestrator({
        enabled: false,
        model: "anthropic/claude-sonnet-4",
        strategy: "always",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no model", () => {
    expect(routeAlwaysOrchestrator({ enabled: true, strategy: "always" })).toBeUndefined();
  });
});

// ── Session Pinning ──────────────────────────────────────────────────────────

describe("session pinning", () => {
  afterEach(() => {
    clearAllSessionPins();
  });

  it("pins a session to a routing result", () => {
    const result = routeMessage({
      message: "hey",
      routing: { enabled: true, fastModel: "ollama/qwen3:1.7b" },
    })!;
    pinSession("session-1", result);

    const pin = getSessionPin("session-1");
    expect(pin).toBeDefined();
    expect(pin!.provider).toBe("ollama");
    expect(pin!.model).toBe("qwen3:1.7b");
    expect(pin!.complexity).toBe("simple");
    expect(pin!.pinnedAt).toBeGreaterThan(0);
  });

  it("does not pin when result has no provider/model", () => {
    pinSession("session-2", { complexity: "complex", disableTools: false });
    expect(getSessionPin("session-2")).toBeUndefined();
  });

  it("unpins a session", () => {
    pinSession("session-3", {
      complexity: "simple",
      provider: "ollama",
      model: "qwen3:1.7b",
      disableTools: true,
    });
    expect(unpinSession("session-3")).toBe(true);
    expect(getSessionPin("session-3")).toBeUndefined();
  });

  it("unpinSession returns false for unknown session", () => {
    expect(unpinSession("nonexistent")).toBe(false);
  });

  it("clearAllSessionPins clears all pins", () => {
    pinSession("s1", { complexity: "simple", provider: "a", model: "b", disableTools: false });
    pinSession("s2", { complexity: "moderate", provider: "c", model: "d", disableTools: false });
    clearAllSessionPins();
    expect(getSessionPin("s1")).toBeUndefined();
    expect(getSessionPin("s2")).toBeUndefined();
    expect(_sessionPinInternals.sessionPins.size).toBe(0);
  });

  it("overwrites existing pin on re-pin", () => {
    pinSession("s1", { complexity: "simple", provider: "a", model: "b", disableTools: false });
    pinSession("s1", { complexity: "complex", provider: "x", model: "y", disableTools: false });
    const pin = getSessionPin("s1");
    expect(pin!.provider).toBe("x");
    expect(pin!.model).toBe("y");
    expect(pin!.complexity).toBe("complex");
  });
});

// ── Provider-prefixed model ID normalization ─────────────────────────────────

describe("routeMessage normalizes provider-prefixed model IDs", () => {
  it("normalizes z.ai provider prefix in fastModel", () => {
    const result = routeMessage({
      message: "hey",
      routing: {
        enabled: true,
        fastModel: "z.ai/zai-mini",
        localModel: "ollama/gemma3:12b",
      },
    });
    expect(result?.provider).toBe("zai");
    expect(result?.model).toBe("zai-mini");
  });

  it("normalizes qwen provider prefix in localModel", () => {
    const result = routeMessage({
      message: "show me the logs",
      routing: {
        enabled: true,
        fastModel: "ollama/small",
        localModel: "qwen/qwen-turbo",
      },
    });
    expect(result?.provider).toBe("qwen-portal");
    expect(result?.model).toBe("qwen-turbo");
  });

  it("normalizes Anthropic model aliases in personaModels", () => {
    const result = routeMessage({
      message: "hello",
      routing: {
        enabled: true,
        fastModel: "ollama/small",
        personaModels: { Researcher: "anthropic/opus-4.5" },
      },
      currentPersona: "Researcher",
    });
    expect(result?.provider).toBe("anthropic");
    expect(result?.model).toBe("claude-opus-4-5");
  });

  it("normalizes kimi-code provider prefix in ecoModel", () => {
    const result = routeMessage({
      message: "hi",
      routing: {
        enabled: true,
        fastModel: "ollama/small",
        ecoModel: "kimi-code/kimi-lite",
      },
    });
    expect(result?.provider).toBe("kimi-coding");
    expect(result?.model).toBe("kimi-lite");
  });
});
