import { vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

type MockFn = ReturnType<typeof vi.fn>;

export type SessionStoreMock = {
  store: Record<string, SessionEntry>;
  mocks: {
    loadSessionStore: MockFn;
    saveSessionStore: MockFn;
    resolveSessionKey: MockFn;
    resolveStorePath: MockFn;
    resolveAgentMainSessionKey: MockFn;
  };
};

/**
 * Create a session store mock matching the shape tests use with vi.mock("config/sessions.js").
 *
 * Usage:
 * ```ts
 * const { store, mocks } = createSessionStoreMock();
 * vi.mock("../../config/sessions.js", () => mocks);
 * // Pre-populate: store["main"] = { sessionId: "s1", updatedAt: Date.now() };
 * ```
 */
export function createSessionStoreMock(initial?: Record<string, SessionEntry>): SessionStoreMock {
  const store: Record<string, SessionEntry> = initial ?? {};

  const mocks = {
    loadSessionStore: vi.fn((_storePath?: string) => ({ ...store })),
    saveSessionStore: vi.fn(async (_storePath: string, _data: unknown) => {}),
    resolveSessionKey: vi.fn((_scope: unknown, _ctx: unknown, _mainKey?: string) => "main"),
    resolveStorePath: vi.fn((_store?: unknown, _opts?: unknown) => "/mock/store.json"),
    resolveAgentMainSessionKey: vi.fn(
      ({ agentId }: { agentId: string }) => `agent:${agentId}:main`,
    ),
  };

  return { store, mocks };
}
