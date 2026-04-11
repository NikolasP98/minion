/**
 * Mem0Adapter — TypeScript-native HTTP client to Mem0 REST API.
 *
 * Phase 1 of MIN-558 (Mem0 Structured Personalized Memory).
 *
 * Design decisions:
 * - Pure HTTP client — no Python sidecar, no new dependencies.
 * - Tight timeouts: 2s for search (hot path), 5s for add (fire-and-forget).
 * - All public methods are fail-safe: search returns [], add never throws.
 * - Cross-channel userId convention: "{platformId}:{userId}"
 *   e.g. "whatsapp:+15551234", "telegram:123456"
 *
 * Env vars (resolved via resolveMem0Config):
 *   MEM0_API_URL     — Mem0 server base URL (default: http://localhost:8888)
 *   MEM0_API_KEY     — Optional Bearer auth token
 *   MEM0_COLLECTION  — Qdrant collection to use (default: "mem0_memories")
 *   MEM0_EMBEDDER    — Embedding model (default: "text-embedding-3-small")
 *   MEM0_LLM_MODEL   — LLM for contradiction resolution (default: "gpt-4o-mini")
 *   MEM0_TOP_K       — Max results to retrieve (default: 5)
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { fetchWithTimeout } from "../shared/fetch-timeout.js";

const log = createSubsystemLogger("mem0");

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 2_000;
const ADD_TIMEOUT_MS = 5_000;
const DEFAULT_API_URL = "http://localhost:8888";
const DEFAULT_COLLECTION = "mem0_memories";
const DEFAULT_EMBEDDER = "text-embedding-3-small";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const DEFAULT_TOP_K = 5;

// ── Public types ──────────────────────────────────────────────────────────────

export interface Mem0Config {
  /** Mem0 server base URL. */
  apiUrl: string;
  /** Optional Bearer auth token. */
  apiKey?: string;
  /** Qdrant collection name. */
  qdrantCollection: string;
  /** Embedding model for vectorisation. */
  embedderModel: string;
  /** LLM model used for contradiction resolution. */
  llmModel: string;
  /** Max results to retrieve per search. */
  topK: number;
}

export interface Mem0Memory {
  id: string;
  memory: string;
  userId: string;
  metadata?: Record<string, string>;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Minimal chat message for mem0 ingestion. */
export interface Mem0ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ── Config resolution ─────────────────────────────────────────────────────────

export function resolveMem0Config(): Mem0Config {
  const topKRaw = process.env.MEM0_TOP_K;
  const topK = topKRaw ? parseInt(topKRaw, 10) : DEFAULT_TOP_K;

  return {
    apiUrl: (process.env.MEM0_API_URL?.trim() || DEFAULT_API_URL).replace(/\/$/, ""),
    apiKey: process.env.MEM0_API_KEY?.trim() || undefined,
    qdrantCollection: process.env.MEM0_COLLECTION?.trim() || DEFAULT_COLLECTION,
    embedderModel: process.env.MEM0_EMBEDDER?.trim() || DEFAULT_EMBEDDER,
    llmModel: process.env.MEM0_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
    topK: Number.isFinite(topK) && topK > 0 ? topK : DEFAULT_TOP_K,
  };
}

// ── Implementation ────────────────────────────────────────────────────────────

export class Mem0Adapter {
  private readonly config: Mem0Config;
  private readonly headers: Record<string, string>;

  constructor(config: Mem0Config) {
    this.config = config;
    this.headers = {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
  }

  /**
   * Add messages to Mem0 memory for a user.
   * Fire-and-forget safe — never throws.
   * Timeout: 5 seconds.
   */
  async add(
    messages: Mem0ChatMessage[],
    userId: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    try {
      const body = JSON.stringify({
        messages,
        user_id: userId,
        metadata,
        collection: this.config.qdrantCollection,
      });

      const resp = await fetchWithTimeout(
        `${this.config.apiUrl}/v1/memories`,
        { method: "POST", headers: this.headers, body },
        ADD_TIMEOUT_MS,
      );

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        log.warn(`[mem0] add failed HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      } else {
        log.info(`[mem0] add ok user=${userId} messages=${messages.length}`);
      }
    } catch (err) {
      log.warn(`[mem0] add error: ${String(err)}`);
    }
  }

  /**
   * Search Mem0 memories for a user.
   * Always returns an array — never throws.
   * Timeout: 2 seconds.
   */
  async search(query: string, userId: string): Promise<Mem0Memory[]> {
    try {
      const body = JSON.stringify({
        query,
        user_id: userId,
        top_k: this.config.topK,
        collection: this.config.qdrantCollection,
      });

      const resp = await fetchWithTimeout(
        `${this.config.apiUrl}/v1/memories/search`,
        { method: "POST", headers: this.headers, body },
        SEARCH_TIMEOUT_MS,
      );

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        log.warn(`[mem0] search failed HTTP ${resp.status}: ${txt.slice(0, 200)}`);
        return [];
      }

      const data = (await resp.json()) as { results?: Mem0Memory[]; memories?: Mem0Memory[] };
      const results = data.results ?? data.memories ?? [];
      log.info(`[mem0] search ok user=${userId} results=${results.length}`);
      return results;
    } catch (err) {
      log.warn(`[mem0] search error: ${String(err)}`);
      return [];
    }
  }

  /**
   * Health check — returns true if Mem0 server is reachable.
   */
  async ping(): Promise<boolean> {
    try {
      const resp = await fetchWithTimeout(
        `${this.config.apiUrl}/v1/health`,
        { method: "GET", headers: this.headers },
        SEARCH_TIMEOUT_MS,
      );
      return resp.ok;
    } catch {
      return false;
    }
  }
}
