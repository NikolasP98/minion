/**
 * Model context window catalog — known context sizes for popular models.
 *
 * Used by the fallback system to skip models whose context window is too
 * small for the current conversation.
 *
 * Context window values are in tokens. Sources: official documentation.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ModelContextSpec = {
  /** Context window size in tokens. */
  contextWindow: number;
};

// ── Catalog Data ─────────────────────────────────────────────────────────────

/**
 * Known model context windows. Key format: lowercase model id (without provider prefix).
 * For Ollama models, use the tag-qualified name (e.g. "qwen3:1.7b").
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-sonnet-4": 200_000,
  "claude-opus-4": 200_000,
  "claude-haiku-3.5": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,

  // OpenAI
  "gpt-5.2": 200_000, // ClawRouter v0.10.0
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,

  // Google
  "gemini-3.1-pro": 2_000_000, // ClawRouter v0.10.0 (preview)
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000, // ClawRouter v0.10.0 ECO tier
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,

  // Groq-hosted
  "mixtral-8x7b": 32_768,

  // Mistral
  "mistral-large": 128_000,
  codestral: 32_000,
  "pixtral-large": 128_000,

  // DeepSeek
  "deepseek-chat": 64_000,
  "deepseek-coder": 16_384,
  "deepseek-r1": 64_000,

  // xAI
  "grok-2": 131_072,
  "grok-3": 131_072,

  // Meta AI (Llama 4)
  "llama4-maverick": 1_000_000,
  "meta-llama/llama-4-maverick-17b-128e-instruct": 1_000_000,
  "meta-llama/llama-4-maverick-17b-128e-instruct-fp8": 1_000_000,

  // Local models (common Ollama tags)
  "qwen3:1.7b": 4_096,
  "qwen3:8b": 32_768,
  "qwen3:30b": 32_768,
  "gemma3:2b": 8_192,
  "gemma3:12b": 8_192,
  "gemma3:27b": 8_192,
  "llama3:8b": 8_192,
  "llama3:70b": 8_192,
  "phi-4": 16_384,
  "deepseek-r1:8b": 32_768,
  "deepseek-r1:14b": 32_768,
};

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Look up the context window size for a model.
 *
 * Tries exact match first, then prefix matching (e.g. "claude-sonnet-4-20250514"
 * matches "claude-sonnet-4"). Returns undefined for unknown models.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  const lower = modelId.toLowerCase();

  // Exact match
  const exact = MODEL_CONTEXT_WINDOWS[lower];
  if (exact !== undefined) {
    return exact;
  }

  // Prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.startsWith(key)) {
      return value;
    }
  }

  return undefined;
}

/**
 * Check if a model's context window can accommodate the estimated token count.
 *
 * Uses a 1.1x safety margin — the model is considered viable if its context
 * window is at least 110% of the estimated tokens.
 *
 * Returns true for unknown models (fail-open: don't skip what we can't measure).
 */
export function modelFitsContext(modelId: string, estimatedTokens: number): boolean {
  const contextWindow = getModelContextWindow(modelId);
  if (contextWindow === undefined) {
    return true; // Unknown model — fail-open
  }
  return contextWindow >= estimatedTokens * 1.1;
}

// ── Tool Calling Capability ───────────────────────────────────────────────────

/**
 * Models known to NOT support tool/function calling.
 *
 * Key format: lowercase model-id prefix (without provider prefix).
 * Prefix matching is used — "minimax" matches "minimax/abab6.5-chat", etc.
 *
 * Only list models where tool calling is confirmed broken or unsupported.
 * Unknown models are treated as tool-capable (fail-open).
 *
 * Sources:
 * - Minimax removed from ClawRouter auto-routing chains due to tool schema
 *   incompatibilities (ClawRouter v0.10.0, commit 0255524)
 */
const TOOL_INCOMPATIBLE_PREFIXES: ReadonlySet<string> = new Set([
  "minimax",
]);

/**
 * Check if a model supports tool/function calling.
 *
 * Returns false only for models explicitly listed as tool-incompatible.
 * Returns true for unknown models (fail-open: don't skip what we can't verify).
 */
export function modelSupportsToolCalling(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  for (const prefix of TOOL_INCOMPATIBLE_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`) || lower.startsWith(`${prefix}-`)) {
      return false;
    }
  }
  return true;
}
