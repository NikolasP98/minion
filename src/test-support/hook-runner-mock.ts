import { vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;

export type HookRunnerMock = {
  runner: Record<string, MockFn> & {
    hasHooks: MockFn;
    runBeforeToolCall: MockFn;
    runAfterToolCall: MockFn;
    runBeforeCompaction: MockFn;
    runAfterCompaction: MockFn;
    runBeforeReply: MockFn;
    runAfterReply: MockFn;
  };
  /** Module-shaped object for vi.mock() factory. */
  moduleMock: {
    getGlobalHookRunner: () => HookRunnerMock["runner"];
  };
};

/**
 * Create a hook runner mock matching the pattern used across tests.
 *
 * Usage:
 * ```ts
 * const { runner, moduleMock } = createHookRunnerMock();
 * vi.mock("../../plugins/hook-runner-global.js", () => moduleMock);
 * // Configure: runner.hasHooks.mockReturnValue(true);
 * ```
 */
export function createHookRunnerMock(): HookRunnerMock {
  const runner = {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(async () => ({})),
    runAfterToolCall: vi.fn(async () => {}),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
    runBeforeReply: vi.fn(async () => ({})),
    runAfterReply: vi.fn(async () => {}),
  } as HookRunnerMock["runner"];

  return {
    runner,
    moduleMock: {
      getGlobalHookRunner: () => runner,
    },
  };
}
