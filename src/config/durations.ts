/**
 * Named duration constants in milliseconds.
 *
 * Use these instead of inline expressions like `5 * 60 * 1000`.
 * Adopt incrementally as files are touched — no mass replacement needed.
 */
export const DURATION = {
  SECONDS_1: 1_000,
  SECONDS_5: 5_000,
  SECONDS_10: 10_000,
  SECONDS_30: 30_000,
  MINUTES_1: 60_000,
  MINUTES_5: 5 * 60_000,
  MINUTES_10: 10 * 60_000,
  MINUTES_30: 30 * 60_000,
  HOURS_1: 3_600_000,
  HOURS_24: 86_400_000,
} as const;
