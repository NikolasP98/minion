import type { MinionConfig } from "../config/types.minion.js";

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: DeepPartial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(overrides)) {
    const val = (overrides as Record<string, unknown>)[key];
    const baseVal = result[key];
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        val as DeepPartial<Record<string, unknown>>,
      );
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

const BASE_CONFIG: MinionConfig = {
  channels: {},
  agents: {},
  session: {},
  gateway: {},
};

/**
 * Build a MinionConfig with sensible defaults, deep-merging any overrides.
 * Eliminates the need for `as MinionConfig` / `as OpenClawConfig` casts in tests.
 */
export function buildConfig(overrides?: DeepPartial<MinionConfig>): MinionConfig {
  if (!overrides) {
    return { ...BASE_CONFIG };
  }
  return deepMerge(BASE_CONFIG, overrides);
}
