/**
 * ParallelMemoryService — wraps existing MemorySearchManager with Mem0Adapter.
 *
 * Phase 2 of MIN-558 (Mem0 Structured Personalized Memory).
 *
 * Concurrently reads from both the primary (existing file-based) memory and
 * Mem0. The existing memory is always the primary context; Mem0 results are
 * appended as supplemental. Each can fail independently without breaking the
 * run.
 *
 * Write path:
 *   - Primary write is synchronous (awaited) — preserves existing behaviour.
 *   - Mem0 write is fire-and-forget — failures are logged, never re-thrown.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Mem0Adapter, Mem0ChatMessage, Mem0Memory } from "./mem0-adapter.js";
import type { MemorySearchManager, MemorySearchResult } from "./types.js";

const log = createSubsystemLogger("parallel-memory");

// ── Public types ──────────────────────────────────────────────────────────────

export interface ParallelSearchResult {
  /** Primary results from the existing file-based memory. */
  primary: MemorySearchResult[];
  /** Supplemental results from Mem0 (empty array on failure or when disabled). */
  supplemental: Mem0Memory[];
  /** True when the primary memory search failed and mem0 was used as fallback. */
  usedMem0Fallback: boolean;
}

export interface ParallelMemoryReadOpts {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class ParallelMemoryService {
  constructor(
    private readonly primary: MemorySearchManager,
    private readonly mem0: Mem0Adapter | null,
  ) {}

  /**
   * Run primary and Mem0 search concurrently.
   *
   * - Both are started at the same time with Promise.allSettled.
   * - Primary results are always the first element of the response.
   * - Mem0 results are supplemental; on primary failure, mem0 serves as fallback.
   * - This method never throws.
   */
  async search(
    query: string,
    userId: string,
    opts?: ParallelMemoryReadOpts,
  ): Promise<ParallelSearchResult> {
    const primaryPromise = this.primary.search(query, {
      maxResults: opts?.maxResults,
      minScore: opts?.minScore,
      sessionKey: opts?.sessionKey,
    });

    const mem0Promise = this.mem0
      ? this.mem0.search(query, userId)
      : Promise.resolve([] as Mem0Memory[]);

    const [primaryResult, mem0Result] = await Promise.allSettled([primaryPromise, mem0Promise]);

    const primaryOk = primaryResult.status === "fulfilled";
    const mem0Ok = mem0Result.status === "fulfilled";

    if (!primaryOk) {
      log.warn(`[parallel-memory] primary search failed: ${String(primaryResult.reason)}`);
    }
    if (!mem0Ok) {
      log.warn(`[parallel-memory] mem0 search failed: ${String(mem0Result.reason)}`);
    }

    const primary = primaryOk ? primaryResult.value : [];
    const supplemental = mem0Ok ? mem0Result.value : [];
    const usedMem0Fallback = !primaryOk && supplemental.length > 0;

    log.info(
      `[parallel-memory] search user=${userId} primary=${primary.length} supplemental=${supplemental.length} fallback=${usedMem0Fallback}`,
    );

    return { primary, supplemental, usedMem0Fallback };
  }

  /**
   * Write messages to primary memory (awaited) and mem0 (fire-and-forget).
   *
   * Primary write errors are re-thrown. Mem0 errors are swallowed.
   */
  async write(
    messages: Mem0ChatMessage[],
    userId: string,
    writePrimary: (messages: Mem0ChatMessage[]) => Promise<void>,
  ): Promise<void> {
    // Primary write — synchronous, preserves existing behaviour.
    await writePrimary(messages);

    // Mem0 write — fire-and-forget.
    if (this.mem0) {
      void this.mem0.add(messages, userId).catch((err) => {
        log.warn(`[parallel-memory] mem0 add failed: ${String(err)}`);
      });
    }
  }
}
