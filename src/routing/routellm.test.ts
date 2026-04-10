import { describe, expect, it } from "vitest";
import {
  createRouteLLMConfig,
  FRONTIER_ONLY_TASK_TYPES,
  recordCheapModelOutcome,
  routeTask,
  type RouteLLMConfig,
} from "./routellm.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const enabledConfig: RouteLLMConfig = {
  enabled: true,
  threshold: 0.80,
  cheapModel: "claude-haiku-4-5-20251001",
  frontierModel: "claude-sonnet-4-6",
};

const disabledConfig: RouteLLMConfig = {
  enabled: false,
  threshold: 0.80,
  cheapModel: "claude-haiku-4-5-20251001",
  frontierModel: "claude-sonnet-4-6",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("routeTask", () => {
  describe("disabled config", () => {
    it("always returns frontier model", () => {
      const decision = routeTask({ prompt: "Hello" }, disabledConfig);
      expect(decision.model).toBe("claude-sonnet-4-6");
      expect(decision.usedCheapModel).toBe(false);
      expect(decision.frontierReason).toBe("disabled");
    });

    it("returns confidence 0 when disabled", () => {
      const decision = routeTask({ prompt: "Hello", taskType: "chat" }, disabledConfig);
      expect(decision.confidence).toBe(0);
    });
  });

  describe("FRONTIER_ONLY task types", () => {
    it.each([...FRONTIER_ONLY_TASK_TYPES])(
      "bypasses classifier for %s task type",
      (taskType) => {
        const decision = routeTask(
          { prompt: "Execute this code", taskType },
          enabledConfig,
        );
        expect(decision.model).toBe("claude-sonnet-4-6");
        expect(decision.usedCheapModel).toBe(false);
        expect(decision.frontierReason).toBe("frontier_only_task_type");
        expect(decision.confidence).toBe(1.0);
      },
    );

    it("contains expected frontier-only task types", () => {
      expect(FRONTIER_ONLY_TASK_TYPES).toContain("code_execution");
      expect(FRONTIER_ONLY_TASK_TYPES).toContain("security");
      expect(FRONTIER_ONLY_TASK_TYPES).toContain("hitl_approval");
      expect(FRONTIER_ONLY_TASK_TYPES).toContain("outcome_judge");
    });
  });

  describe("chat tasks", () => {
    it("routes simple chat to cheap model", () => {
      const decision = routeTask(
        { prompt: "What is the capital of France?", taskType: "chat" },
        enabledConfig,
      );
      expect(decision.usedCheapModel).toBe(true);
      expect(decision.model).toBe("claude-haiku-4-5-20251001");
    });

    it("confidence is high for simple chat", () => {
      const decision = routeTask(
        { prompt: "Hi, how are you?", taskType: "chat" },
        enabledConfig,
      );
      expect(decision.confidence).toBeGreaterThan(0.50);
    });
  });

  describe("code tasks", () => {
    it("routes complex code to frontier model", () => {
      const decision = routeTask(
        {
          prompt:
            "Implement a distributed consensus algorithm using Raft with leader election and log replication",
          taskType: "code",
          hasToolCalls: true,
        },
        enabledConfig,
      );
      expect(decision.usedCheapModel).toBe(false);
      expect(decision.model).toBe("claude-sonnet-4-6");
    });

    it("code tasks have lower confidence than chat tasks", () => {
      const chatDecision = routeTask(
        { prompt: "Hello world", taskType: "chat" },
        enabledConfig,
      );
      const codeDecision = routeTask(
        { prompt: "Implement a binary search tree", taskType: "code" },
        enabledConfig,
      );
      expect(chatDecision.confidence).toBeGreaterThan(codeDecision.confidence);
    });
  });

  describe("reasoning tasks", () => {
    it("routes reasoning to frontier model by default", () => {
      const decision = routeTask(
        {
          prompt:
            "Analyze the trade-offs between microservices and monolithic architectures in depth",
          taskType: "reasoning",
        },
        enabledConfig,
      );
      expect(decision.usedCheapModel).toBe(false);
      expect(decision.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("threshold behavior", () => {
    it("uses cheap model when confidence equals threshold", () => {
      // Use a task that produces a known confidence around the boundary.
      // We test by using threshold=1.0 (never cheap) and threshold=0.0 (always cheap).
      const neverCheap: RouteLLMConfig = { ...enabledConfig, threshold: 1.0 };
      const alwaysCheap: RouteLLMConfig = { ...enabledConfig, threshold: 0.0 };

      const neverDecision = routeTask(
        { prompt: "Hello", taskType: "chat" },
        neverCheap,
      );
      const alwaysDecision = routeTask(
        { prompt: "Hello", taskType: "chat" },
        alwaysCheap,
      );

      expect(neverDecision.usedCheapModel).toBe(false);
      expect(alwaysDecision.usedCheapModel).toBe(true);
    });

    it("custom cheap/frontier model names are used", () => {
      const customConfig: RouteLLMConfig = {
        enabled: true,
        threshold: 0.0,
        cheapModel: "gpt-4o-mini",
        frontierModel: "claude-opus-4-6",
      };
      const decision = routeTask({ prompt: "Hello", taskType: "chat" }, customConfig);
      expect(decision.model).toBe("gpt-4o-mini");
    });
  });

  describe("tool call penalty", () => {
    it("tool calls reduce cheap model confidence", () => {
      const withTools = routeTask(
        { prompt: "Hello", taskType: "chat", hasToolCalls: true },
        enabledConfig,
      );
      const withoutTools = routeTask(
        { prompt: "Hello", taskType: "chat", hasToolCalls: false },
        enabledConfig,
      );
      expect(withoutTools.confidence).toBeGreaterThan(withTools.confidence);
    });
  });

  describe("context length penalty", () => {
    it("large context reduces cheap model confidence", () => {
      const largeContext = routeTask(
        { prompt: "Summarize this", taskType: "research", contextLength: 8000 },
        enabledConfig,
      );
      const smallContext = routeTask(
        { prompt: "Summarize this", taskType: "research", contextLength: 100 },
        enabledConfig,
      );
      expect(smallContext.confidence).toBeGreaterThan(largeContext.confidence);
    });
  });

  describe("confidence range", () => {
    it("confidence is always in [0, 1]", () => {
      const cases = [
        { prompt: "Hi", taskType: "chat" as const },
        { prompt: "Write me a whole OS", taskType: "code" as const, hasToolCalls: true, contextLength: 8000 },
        { prompt: "Explain quantum entanglement step by step", taskType: "reasoning" as const },
        { prompt: "Summarize this article", taskType: "research" as const },
      ];
      for (const input of cases) {
        const decision = routeTask(input, enabledConfig);
        expect(decision.confidence).toBeGreaterThanOrEqual(0);
        expect(decision.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe("createRouteLLMConfig", () => {
  it("creates config with defaults", () => {
    const config = createRouteLLMConfig({});
    expect(config.enabled).toBe(false);
    expect(config.threshold).toBe(0.80);
    expect(config.cheapModel).toBe("claude-haiku-4-5-20251001");
    expect(config.frontierModel).toBe("claude-sonnet-4-6");
    expect(config.logDecisions).toBe(false);
  });

  it("overrides apply correctly", () => {
    const config = createRouteLLMConfig({
      enabled: true,
      threshold: 0.9,
      cheapModel: "gpt-4o-mini",
      frontierModel: "claude-opus-4-6",
      logDecisions: true,
    });
    expect(config.enabled).toBe(true);
    expect(config.threshold).toBe(0.9);
    expect(config.cheapModel).toBe("gpt-4o-mini");
    expect(config.frontierModel).toBe("claude-opus-4-6");
    expect(config.logDecisions).toBe(true);
  });
});

describe("recordCheapModelOutcome", () => {
  it("does not throw with no outcomes", () => {
    expect(() => recordCheapModelOutcome(false)).not.toThrow();
  });

  it("does not throw on success outcomes", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => recordCheapModelOutcome(false)).not.toThrow();
    }
  });

  it("does not throw on mixed outcomes below threshold", () => {
    for (let i = 0; i < 10; i++) {
      // 1 failure in 10 = 10%, should not alert (> 10%, not >= 10%)
      expect(() => recordCheapModelOutcome(i === 0)).not.toThrow();
    }
  });
});
