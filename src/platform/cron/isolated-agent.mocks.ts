import { vi } from "vitest";

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../../agents/models/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

vi.mock("../../agents/subagents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));
