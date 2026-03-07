import { vi } from "vitest";

const LOGGER_METHODS = ["debug", "info", "warn", "error", "log", "trace", "fatal"] as const;

/**
 * Create a no-op logger — all methods are silent no-ops.
 * Useful as a drop-in for any logger dependency.
 */
export function createNoopLogger(): Record<string, (...args: unknown[]) => void> {
  const logger: Record<string, (...args: unknown[]) => void> = {};
  for (const method of LOGGER_METHODS) {
    logger[method] = () => {};
  }
  return logger;
}

type MockFn = ReturnType<typeof vi.fn>;

/**
 * Create a spy logger — all methods are vi.fn() spies.
 * Useful when you need to assert on log calls.
 */
export function createSpyLogger(): Record<(typeof LOGGER_METHODS)[number], MockFn> &
  Record<string, MockFn> {
  const logger: Record<string, MockFn> = {};
  for (const method of LOGGER_METHODS) {
    logger[method] = vi.fn();
  }
  return logger as Record<(typeof LOGGER_METHODS)[number], MockFn> & Record<string, MockFn>;
}
