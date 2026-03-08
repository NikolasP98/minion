/**
 * Per-tool sliding window rate limiter.
 *
 * Prevents runaway tool calls in autonomous loops (cron, heartbeat).
 * Each tool can have its own rate limit config. When a limit is hit,
 * the caller receives a structured error with `retryAfter` seconds.
 *
 * Rate limits are opt-in per tool. Tools without a configured limit
 * are never rate-limited.
 *
 * Inspired by IronClaw's `src/tools/rate_limiter.rs` (shipped v0.9.0).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeToolName } from "./normalize-tool-name.js";

const log = createSubsystemLogger("tools/rate-limiter");

// ── Types ────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Maximum calls allowed within the window. */
  maxCalls: number;
  /** Window duration in seconds. */
  windowSecs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest call in the window expires (0 if allowed). */
  retryAfter: number;
  /** Current call count in the window. */
  currentCount: number;
  /** Configured limit. */
  limit: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class ToolRateLimiter {
  /** Per-tool config. Tools not in this map are unlimited. */
  private configs: Map<string, RateLimitConfig>;
  /** Per-tool sliding window of call timestamps (ms). */
  private windows: Map<string, number[]> = new Map();

  constructor(configs?: Record<string, RateLimitConfig>) {
    this.configs = new Map(Object.entries(configs ?? {}));
  }

  /**
   * Add or update rate limit config for a tool.
   */
  setConfig(toolName: string, config: RateLimitConfig): void {
    this.configs.set(normalizeToolName(toolName), config);
  }

  /**
   * Check whether a tool call is allowed and record it if so.
   *
   * Returns `{ allowed: true }` if the call is within limits.
   * Returns `{ allowed: false, retryAfter }` if rate limited.
   */
  tryCall(toolName: string): RateLimitResult {
    const key = normalizeToolName(toolName);
    const config = this.configs.get(key);

    // No config → unlimited.
    if (!config) {
      return { allowed: true, retryAfter: 0, currentCount: 0, limit: 0 };
    }

    const now = Date.now();
    const windowMs = config.windowSecs * 1000;
    const cutoff = now - windowMs;

    // Get or create window.
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune expired entries.
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    // Check limit.
    if (timestamps.length >= config.maxCalls) {
      const oldestExpiry = timestamps[0] + windowMs;
      const retryAfter = Math.ceil((oldestExpiry - now) / 1000);
      log.debug(
        `Rate limited: ${toolName} (${timestamps.length}/${config.maxCalls} in ${config.windowSecs}s, retry in ${retryAfter}s)`,
      );
      return {
        allowed: false,
        retryAfter: Math.max(1, retryAfter),
        currentCount: timestamps.length,
        limit: config.maxCalls,
      };
    }

    // Record and allow.
    timestamps.push(now);
    return {
      allowed: true,
      retryAfter: 0,
      currentCount: timestamps.length,
      limit: config.maxCalls,
    };
  }

  /**
   * Check without recording (peek).
   */
  wouldAllow(toolName: string): boolean {
    const key = normalizeToolName(toolName);
    const config = this.configs.get(key);
    if (!config) {
      return true;
    }

    const timestamps = this.windows.get(key);
    if (!timestamps) {
      return true;
    }

    const cutoff = Date.now() - config.windowSecs * 1000;
    const active = timestamps.filter((t) => t >= cutoff);
    return active.length < config.maxCalls;
  }

  /**
   * Get current stats for all rate-limited tools.
   */
  stats(): Array<{
    tool: string;
    config: RateLimitConfig;
    currentCount: number;
    allowed: boolean;
  }> {
    const result: Array<{
      tool: string;
      config: RateLimitConfig;
      currentCount: number;
      allowed: boolean;
    }> = [];
    for (const [key, config] of this.configs) {
      const timestamps = this.windows.get(key) ?? [];
      const cutoff = Date.now() - config.windowSecs * 1000;
      const active = timestamps.filter((t) => t >= cutoff);
      result.push({
        tool: key,
        config,
        currentCount: active.length,
        allowed: active.length < config.maxCalls,
      });
    }
    return result;
  }

  /** Format a rate limit error for the LLM. */
  static formatError(toolName: string, result: RateLimitResult): string {
    return `Tool "${toolName}" is rate limited: ${result.currentCount}/${result.limit} calls used. Try again in ${result.retryAfter} seconds.`;
  }
}
