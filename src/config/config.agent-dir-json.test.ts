import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";

const silentLogger = { warn: vi.fn(), error: vi.fn() };

describe("agents/ directory hierarchy — agent.json scan", () => {
  it("merges agent.json into existing agents.list entry", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({
          agents: {
            list: [{ id: "claudecoder", name: "Claude Coder Base" }],
          },
        }),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "claudecoder");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({
          id: "claudecoder",
          sandbox: {
            docker: { memory: "2g", cpus: 1.0 },
          },
        }),
        "utf-8",
      );

      const cfg = loadConfig();
      const agent = cfg.agents?.list?.find((a) => a.id === "claudecoder");

      // Base config name preserved
      expect(agent?.name).toBe("Claude Coder Base");
      // Docker limits applied from agent.json
      expect(agent?.sandbox?.docker?.memory).toBe("2g");
      expect(agent?.sandbox?.docker?.cpus).toBe(1.0);
    });
  });

  it("inserts new agent from agent.json when not in base config", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "main" }] } }),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "coder");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ id: "coder", sandbox: { mode: "all" } }),
        "utf-8",
      );

      const cfg = loadConfig();
      const ids = cfg.agents?.list?.map((a) => a.id) ?? [];

      expect(ids).toContain("main");
      expect(ids).toContain("coder");
      const coder = cfg.agents?.list?.find((a) => a.id === "coder");
      expect(coder?.sandbox?.mode).toBe("all");
    });
  });

  it("inserts new agent from agent.json when agents.list is absent in base config", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({}),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "alpha");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ id: "alpha", sandbox: { docker: { memory: "512m" } } }),
        "utf-8",
      );

      const cfg = loadConfig();
      const alpha = cfg.agents?.list?.find((a) => a.id === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha?.sandbox?.docker?.memory).toBe("512m");
    });
  });

  it("deep-merges nested sandbox.docker fields without wiping base sandbox config", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({
          agents: {
            list: [{ id: "main", sandbox: { mode: "all", docker: { network: "none" } } }],
          },
        }),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "main");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ id: "main", sandbox: { docker: { memory: "1g", cpus: 0.5 } } }),
        "utf-8",
      );

      const cfg = loadConfig();
      const main = cfg.agents?.list?.find((a) => a.id === "main");

      // mode from base config preserved through deep merge
      expect(main?.sandbox?.mode).toBe("all");
      // docker.network from base preserved
      expect(main?.sandbox?.docker?.network).toBe("none");
      // docker limits from agent.json applied
      expect(main?.sandbox?.docker?.memory).toBe("1g");
      expect(main?.sandbox?.docker?.cpus).toBe(0.5);
    });
  });

  it("skips agent.json when file id does not match directory name", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "main" }] } }),
        "utf-8",
      );

      // Directory says "badname" but file claims id "other"
      const agentDir = path.join(stateDir, "agents", "badname");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ id: "other", sandbox: { docker: { memory: "4g" } } }),
        "utf-8",
      );

      const cfg = loadConfig();
      // Neither "badname" nor "other" should appear (they were skipped)
      const ids = cfg.agents?.list?.map((a) => a.id) ?? [];
      expect(ids).not.toContain("badname");
      expect(ids).not.toContain("other");
    });
  });

  it("uses directory name as id when agent.json omits the id field", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({}),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "helper");
      await fs.mkdir(agentDir, { recursive: true });
      // No "id" field in the file — directory name is used
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ sandbox: { docker: { cpus: 2 } } }),
        "utf-8",
      );

      const cfg = loadConfig();
      const helper = cfg.agents?.list?.find((a) => a.id === "helper");
      expect(helper).toBeDefined();
      expect(helper?.sandbox?.docker?.cpus).toBe(2);
    });
  });

  it("silently ignores invalid JSON in agent.json", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "main" }] } }),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "main");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        "{ NOT VALID JSON !!!",
        "utf-8",
      );

      // Should not throw; main agent untouched
      const cfg = loadConfig();
      const main = cfg.agents?.list?.find((a) => a.id === "main");
      expect(main).toBeDefined();
      expect(main?.sandbox).toBeUndefined();
    });
  });

  it("works when agents/ directory does not exist (backward compat)", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "main" }] } }),
        "utf-8",
      );

      // agents/ directory is absent — should not throw
      const cfg = loadConfig();
      expect(cfg.agents?.list?.find((a) => a.id === "main")).toBeDefined();
    });
  });

  it("directories without agent.json are silently skipped", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "main" }] } }),
        "utf-8",
      );

      // Create an agent directory with no agent.json
      await fs.mkdir(path.join(stateDir, "agents", "nomatch"), { recursive: true });

      const cfg = loadConfig();
      const ids = cfg.agents?.list?.map((a) => a.id) ?? [];
      expect(ids).not.toContain("nomatch");
    });
  });

  it("minion.json overrides agent.json (minion.json wins)", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "main" }] } }),
        "utf-8",
      );

      const agentDir = path.join(stateDir, "agents", "main");
      await fs.mkdir(agentDir, { recursive: true });

      // agent.json sets memory to 1g
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ id: "main", sandbox: { docker: { memory: "1g" } } }),
        "utf-8",
      );

      // minion.json overrides memory to 4g
      await fs.writeFile(
        path.join(agentDir, "minion.json"),
        JSON.stringify({ sandbox: { docker: { memory: "4g" } } }),
        "utf-8",
      );

      const cfg = loadConfig();
      const main = cfg.agents?.list?.find((a) => a.id === "main");
      expect(main?.sandbox?.docker?.memory).toBe("4g");
    });
  });

  it("handles multiple agents in separate directories", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".minion");

      await fs.writeFile(
        path.join(stateDir, "gateway.json"),
        JSON.stringify({ agents: { list: [{ id: "alpha" }] } }),
        "utf-8",
      );

      for (const [agentId, memory] of [
        ["alpha", "2g"],
        ["beta", "1g"],
      ] as const) {
        const agentDir = path.join(stateDir, "agents", agentId);
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "agent.json"),
          JSON.stringify({ id: agentId, sandbox: { docker: { memory } } }),
          "utf-8",
        );
      }

      const cfg = loadConfig();
      const alpha = cfg.agents?.list?.find((a) => a.id === "alpha");
      const beta = cfg.agents?.list?.find((a) => a.id === "beta");

      expect(alpha?.sandbox?.docker?.memory).toBe("2g");
      expect(beta?.sandbox?.docker?.memory).toBe("1g");
    });
  });
});
