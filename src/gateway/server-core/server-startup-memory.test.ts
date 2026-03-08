import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinionConfig } from "../../config/config.js";

const {
  getMemorySearchManagerMock,
  listAgentIdsMock,
  resolveMemoryBackendConfigMock,
  setEmbedConcurrencyMock,
} = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
  listAgentIdsMock: vi.fn((_cfg: unknown) => [] as string[]),
  resolveMemoryBackendConfigMock: vi.fn((_params: unknown) => ({
    backend: "builtin" as const,
    citations: "auto" as const,
  })),
  setEmbedConcurrencyMock: vi.fn(),
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: listAgentIdsMock,
}));

vi.mock("../../memory/backend-config.js", () => ({
  resolveMemoryBackendConfig: resolveMemoryBackendConfigMock,
}));

vi.mock("../../memory/compaction/qmd-embed-semaphore.js", () => ({
  setEmbedConcurrency: setEmbedConcurrencyMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockReset();
    listAgentIdsMock.mockReset();
    resolveMemoryBackendConfigMock.mockReset();
    setEmbedConcurrencyMock.mockReset();
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { backend: "builtin" },
    } as MinionConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    listAgentIdsMock.mockReturnValue(["main"]);
    resolveMemoryBackendConfigMock.mockReturnValue({ backend: "builtin", citations: "auto" });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes qmd backend for each configured agent", async () => {
    const cfg = {
      agents: { list: [{ id: "ops", default: true }, { id: "main" }] },
      memory: { backend: "qmd", qmd: {} },
    } as MinionConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    listAgentIdsMock.mockReturnValue(["ops", "main"]);
    resolveMemoryBackendConfigMock.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: { update: { embedConcurrency: 2 } },
    });
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "ops" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, { cfg, agentId: "main" });
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      memory: { backend: "qmd", qmd: {} },
    } as MinionConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    listAgentIdsMock.mockReturnValue(["main", "ops"]);
    resolveMemoryBackendConfigMock.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: { update: { embedConcurrency: 2 } },
    });
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "ops"',
    );
  });
});
