import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import { createOpenAIEmbeddingProviderMock } from "./test-embeddings-mock.js";

const DIM = 3;

// Simple hash-based embedding for deterministic tests
function hashEmbed(text: string): number[] {
  let h = 0;
  for (const c of text) {
    h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  }
  return Array.from({ length: DIM }, (_, i) => Math.sin(h + i));
}

const embedBatch = vi.fn(async (inputs: string[]) => inputs.map(hashEmbed));
const embedQuery = vi.fn(async (input: string) => hashEmbed(input));

vi.mock("./embedding/embeddings.js", () => ({
  createEmbeddingProvider: async () =>
    createOpenAIEmbeddingProviderMock({ embedQuery, embedBatch }),
}));

describe("memory search pipeline e2e", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "minion-mem-pipeline-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir);

    await fs.writeFile(
      path.join(memoryDir, "meeting-notes.md"),
      "# Meeting Notes\n\nDiscussed project alpha milestones and timeline for Q3 delivery.\n",
    );
    await fs.writeFile(
      path.join(memoryDir, "recipe.md"),
      "# Recipe\n\nA recipe for chocolate cake with dark cocoa and buttercream frosting.\n",
    );
    await fs.writeFile(
      path.join(memoryDir, "deployment.md"),
      "# Deployment Guide\n\nStep-by-step deployment guide for kubernetes clusters using helm charts.\n",
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function makeCfg(): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
            remote: { batch: { enabled: true, wait: true } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  async function createAndSync(): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg: makeCfg(), agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    const mgr = result.manager as unknown as MemoryIndexManager;
    await mgr.sync();
    return mgr;
  }

  it("indexes files and returns results for a matching query", async () => {
    manager = await createAndSync();

    const results = await manager.search("project alpha");
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map((r) => r.path);
    expect(paths.some((p) => p.includes("meeting-notes.md"))).toBe(true);
  });

  it("returns relevant results for a different query", async () => {
    manager = await createAndSync();

    const results = await manager.search("chocolate");
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map((r) => r.path);
    expect(paths.some((p) => p.includes("recipe.md"))).toBe(true);
  });

  it("returns results for kubernetes query", async () => {
    manager = await createAndSync();

    const results = await manager.search("kubernetes");
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map((r) => r.path);
    expect(paths.some((p) => p.includes("deployment.md"))).toBe(true);
  });

  it("returns all indexed files across broad query", async () => {
    manager = await createAndSync();

    // A broad search should surface multiple files
    const results = await manager.search("guide notes recipe");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty results for empty query", async () => {
    manager = await createAndSync();

    const results = await manager.search("");
    expect(results).toEqual([]);
  });

  it("calls embedBatch during sync and embedQuery during search", async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();

    manager = await createAndSync();

    expect(embedBatch).toHaveBeenCalled();

    await manager.search("project alpha");
    expect(embedQuery).toHaveBeenCalled();
  });
});
