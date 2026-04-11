/**
 * Semantic cache for LLM responses using Qdrant vector search.
 *
 * On cache get:  embed query → cosine-search Qdrant → return response if score ≥ threshold
 * On cache set:  embed query → LRU-evict if at capacity → upsert to Qdrant
 *
 * Feature flags:
 *   SEMANTIC_CACHE_ENABLED=true|1          — global on/off
 *   CACHE_SIMILARITY_THRESHOLD=0.85        — similarity cutoff (0–1, default 0.85)
 *   QDRANT_URL=http://localhost:6333       — Qdrant server URL
 *   QDRANT_API_KEY=<key>                   — optional Qdrant auth key
 */

import { log as baseLog } from "./logger.js";

const log = baseLog;

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_COLLECTION = "llm_cache";
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h
const EVICT_BATCH_RATIO = 0.1; // evict 10% when at capacity

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal async embedding function — returns a float vector for a text string. */
export type CacheEmbeddingFn = (text: string) => Promise<number[]>;

export interface SemanticCache {
  /** Return cached response for semantically-similar query, or null on miss. */
  get(queryText: string): Promise<string | null>;
  /** Store response keyed by query embedding. */
  set(queryText: string, response: string): Promise<void>;
  /** True when the SEMANTIC_CACHE_ENABLED feature flag is active. */
  isEnabled(): boolean;
}

export interface QdrantSemanticCacheOptions {
  /** Qdrant server URL, e.g. "http://localhost:6333". */
  qdrantUrl: string;
  /** Optional Qdrant API key (required for cloud deployments). */
  qdrantApiKey?: string;
  /** Embedding function used to vectorise queries. */
  embeddingFn: CacheEmbeddingFn;
  /** Dimension of embedding vectors (must match the model). */
  vectorSize: number;
  /** Qdrant collection name. Default: "llm_cache". */
  collectionName?: string;
  /** Cosine similarity threshold for a cache hit. Default: 0.85. */
  similarityThreshold?: number;
  /** Maximum number of cache entries (LRU eviction). Default: 10_000. */
  maxEntries?: number;
  /** Entry TTL in seconds (24h default; informational — enforced via created_at eviction). */
  ttlSeconds?: number;
}

// ── Qdrant REST types ─────────────────────────────────────────────────────────

type QdrantPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

type QdrantScoredPoint = {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
};

// ── Implementation ────────────────────────────────────────────────────────────

export class QdrantSemanticCache implements SemanticCache {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly embeddingFn: CacheEmbeddingFn;
  private readonly vectorSize: number;
  private readonly collection: string;
  private readonly threshold: number;
  private readonly maxEntries: number;
  private readonly ttlSeconds: number;
  private collectionReady = false;

  constructor(opts: QdrantSemanticCacheOptions) {
    this.url = opts.qdrantUrl.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      ...(opts.qdrantApiKey ? { "api-key": opts.qdrantApiKey } : {}),
    };
    this.embeddingFn = opts.embeddingFn;
    this.vectorSize = opts.vectorSize;
    this.collection = opts.collectionName ?? DEFAULT_COLLECTION;
    this.threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  isEnabled(): boolean {
    return isSemanticCacheEnabled();
  }

  async get(queryText: string): Promise<string | null> {
    try {
      await this.ensureCollection();
      const vector = await this.embeddingFn(queryText);
      const results = await this.search(vector, 1);
      if (results.length > 0 && results[0].score >= this.threshold) {
        const hit = results[0];
        const cached = hit.payload?.response as string | undefined;
        if (cached) {
          log.info(
            `[semantic-cache] hit collection=${this.collection} score=${hit.score.toFixed(4)}`,
          );
          return cached;
        }
      }
      log.info(`[semantic-cache] miss collection=${this.collection}`);
      return null;
    } catch (err) {
      log.warn(`[semantic-cache] get error: ${String(err)}`);
      return null;
    }
  }

  async set(queryText: string, response: string): Promise<void> {
    try {
      await this.ensureCollection();
      await this.evictIfNeeded();
      const vector = await this.embeddingFn(queryText);
      const id = crypto.randomUUID();
      const now = Date.now();
      const expiresAt = now + this.ttlSeconds * 1000;
      await this.upsert([
        {
          id,
          vector,
          payload: { response, query: queryText, created_at: now, expires_at: expiresAt },
        },
      ]);
      log.info(`[semantic-cache] stored id=${id} collection=${this.collection}`);
    } catch (err) {
      log.warn(`[semantic-cache] set error: ${String(err)}`);
    }
  }

  // ── Private Qdrant helpers ────────────────────────────────────────────────

  private async ensureCollection(): Promise<void> {
    if (this.collectionReady) {
      return;
    }
    const listRes = await this.qdrantFetch("GET", "/collections");
    const body = (await listRes.json()) as { result?: { collections?: Array<{ name: string }> } };
    const exists = (body.result?.collections ?? []).some((c) => c.name === this.collection);
    if (!exists) {
      const createRes = await this.qdrantFetch("PUT", `/collections/${this.collection}`, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      });
      if (!createRes.ok) {
        const txt = await createRes.text();
        throw new Error(
          `Failed to create collection ${this.collection}: ${createRes.status} ${txt}`,
        );
      }
    }
    this.collectionReady = true;
  }

  private async search(vector: number[], limit: number): Promise<QdrantScoredPoint[]> {
    const res = await this.qdrantFetch("POST", `/collections/${this.collection}/points/search`, {
      vector,
      limit,
      with_payload: true,
      score_threshold: this.threshold,
    });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { result?: QdrantScoredPoint[] };
    return body.result ?? [];
  }

  private async upsert(points: QdrantPoint[]): Promise<void> {
    const res = await this.qdrantFetch("PUT", `/collections/${this.collection}/points`, {
      points,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Qdrant upsert failed: ${res.status} ${txt}`);
    }
  }

  private async count(): Promise<number> {
    const res = await this.qdrantFetch("POST", `/collections/${this.collection}/points/count`, {
      exact: false,
    });
    if (!res.ok) {
      return 0;
    }
    const body = (await res.json()) as { result?: { count?: number } };
    return body.result?.count ?? 0;
  }

  private async evictIfNeeded(): Promise<void> {
    const current = await this.count();
    if (current < this.maxEntries) {
      return;
    }
    const evictN = Math.max(1, Math.floor(this.maxEntries * EVICT_BATCH_RATIO));
    // Scroll oldest entries by created_at ascending
    const scrollRes = await this.qdrantFetch(
      "POST",
      `/collections/${this.collection}/points/scroll`,
      {
        limit: evictN,
        with_payload: ["created_at"],
        order_by: { key: "created_at", direction: "asc" },
      },
    );
    if (!scrollRes.ok) {
      return;
    }
    const scrollBody = (await scrollRes.json()) as {
      result?: { points?: Array<{ id: string }> };
    };
    const ids = (scrollBody.result?.points ?? []).map((p) => p.id);
    if (ids.length === 0) {
      return;
    }
    await this.qdrantFetch("POST", `/collections/${this.collection}/points/delete`, {
      points: ids,
    });
    log.info(`[semantic-cache] evicted ${ids.length} entries`);
  }

  private qdrantFetch(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
}

// ── Feature-flag helpers ──────────────────────────────────────────────────────

/** True when SEMANTIC_CACHE_ENABLED=true|1 is set in the environment. */
export function isSemanticCacheEnabled(): boolean {
  const v = process.env.SEMANTIC_CACHE_ENABLED;
  return v === "true" || v === "1";
}

/** Returns the configured similarity threshold (CACHE_SIMILARITY_THRESHOLD env). */
export function resolveSemanticCacheThreshold(): number {
  const raw = process.env.CACHE_SIMILARITY_THRESHOLD;
  if (raw) {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
      return parsed;
    }
  }
  return DEFAULT_SIMILARITY_THRESHOLD;
}

/**
 * Build a simple OpenAI embedding function from OPENAI_API_KEY.
 * Returns null if the API key is not configured.
 */
export function createOpenAiEmbeddingFn(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): CacheEmbeddingFn {
  const model = params.model ?? "text-embedding-3-small";
  const base = (params.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${params.apiKey}`,
  };
  return async (text: string): Promise<number[]> => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: [text] }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI embeddings failed: ${res.status} ${txt}`);
    }
    const payload = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = payload.data?.[0]?.embedding;
    if (!vec) {
      throw new Error("OpenAI embeddings returned empty vector");
    }
    return vec;
  };
}

/** Default vector size for text-embedding-3-small. */
export const OPENAI_EMBEDDING_3_SMALL_DIMS = 1536;

/**
 * Resolve a ready-to-use QdrantSemanticCache from environment variables,
 * or return null if the cache cannot be configured (missing Qdrant URL or
 * embedding API key).
 */
export function resolveDefaultSemanticCache(): QdrantSemanticCache | null {
  if (!isSemanticCacheEnabled()) {
    return null;
  }
  const qdrantUrl = process.env.QDRANT_URL?.trim();
  if (!qdrantUrl) {
    log.warn("[semantic-cache] SEMANTIC_CACHE_ENABLED but QDRANT_URL is not set — cache disabled");
    return null;
  }
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiKey) {
    log.warn(
      "[semantic-cache] SEMANTIC_CACHE_ENABLED but OPENAI_API_KEY is not set — cache disabled",
    );
    return null;
  }
  return new QdrantSemanticCache({
    qdrantUrl,
    qdrantApiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
    embeddingFn: createOpenAiEmbeddingFn({ apiKey: openaiKey }),
    vectorSize: OPENAI_EMBEDDING_3_SMALL_DIMS,
    similarityThreshold: resolveSemanticCacheThreshold(),
    maxEntries: DEFAULT_MAX_ENTRIES,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  });
}
