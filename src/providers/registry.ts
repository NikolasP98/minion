/**
 * Provider Registry — declarative metadata for LLM providers.
 *
 * Centralizes provider knowledge (API key env vars, model name keywords,
 * capabilities, local vs cloud) into a single lookup table. Adding a new
 * provider is a single data entry — no new classes needed.
 *
 * Inspired by Nanobot's 2-step provider registry pattern.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ProviderCapabilities = {
  /** Whether this provider supports native function/tool calling. */
  nativeToolCalling: boolean;
  /** Whether this provider supports vision (image inputs). */
  vision: boolean;
  /** Whether this provider supports streaming responses. */
  streaming: boolean;
};

export type ProviderSpec = {
  /** Internal name (matches config field, e.g. "anthropic"). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Model name keyword prefixes for matching (e.g. ["claude"] matches "claude-sonnet-4"). */
  keywords: string[];
  /** Environment variable for the API key (empty string for keyless providers). */
  envKey: string;
  /** Default API base URL. */
  defaultApiBase: string;
  /** Whether this is a local model provider (Ollama, LM Studio, etc.). */
  isLocal: boolean;
  /** Provider capabilities. */
  capabilities: ProviderCapabilities;
};

// ── Registry Data ────────────────────────────────────────────────────────────

const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: "anthropic",
    displayName: "Anthropic",
    keywords: ["claude"],
    envKey: "ANTHROPIC_API_KEY",
    defaultApiBase: "https://api.anthropic.com",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "openai",
    displayName: "OpenAI",
    keywords: ["gpt", "o1", "o3", "o4"],
    envKey: "OPENAI_API_KEY",
    defaultApiBase: "https://api.openai.com",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "google",
    displayName: "Google (Gemini)",
    keywords: ["gemini"],
    envKey: "GOOGLE_API_KEY",
    defaultApiBase: "https://generativelanguage.googleapis.com",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "groq",
    displayName: "Groq",
    keywords: ["mixtral"],
    envKey: "GROQ_API_KEY",
    defaultApiBase: "https://api.groq.com",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: false, streaming: true },
  },
  {
    name: "mistral",
    displayName: "Mistral AI",
    keywords: ["mistral", "codestral", "pixtral"],
    envKey: "MISTRAL_API_KEY",
    defaultApiBase: "https://api.mistral.ai",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "deepseek",
    displayName: "DeepSeek",
    keywords: ["deepseek"],
    envKey: "DEEPSEEK_API_KEY",
    defaultApiBase: "https://api.deepseek.com",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: false, streaming: true },
  },
  {
    name: "xai",
    displayName: "xAI (Grok)",
    keywords: ["grok"],
    envKey: "XAI_API_KEY",
    defaultApiBase: "https://api.x.ai",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "ollama",
    displayName: "Ollama (local)",
    keywords: ["qwen", "phi", "llama3", "gemma3", "deepseek-r1"],
    envKey: "",
    defaultApiBase: "http://127.0.0.1:11434",
    isLocal: true,
    capabilities: { nativeToolCalling: true, vision: false, streaming: true },
  },
  {
    name: "lmstudio",
    displayName: "LM Studio (local)",
    keywords: [],
    envKey: "",
    defaultApiBase: "http://127.0.0.1:1234",
    isLocal: true,
    capabilities: { nativeToolCalling: true, vision: false, streaming: true },
  },
  {
    name: "vllm",
    displayName: "vLLM (local)",
    keywords: [],
    envKey: "",
    defaultApiBase: "http://127.0.0.1:8000",
    isLocal: true,
    capabilities: { nativeToolCalling: true, vision: false, streaming: true },
  },
  {
    name: "openrouter",
    displayName: "OpenRouter",
    keywords: [],
    envKey: "OPENROUTER_API_KEY",
    defaultApiBase: "https://openrouter.ai/api",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "together",
    displayName: "Together AI",
    keywords: [],
    envKey: "TOGETHER_API_KEY",
    defaultApiBase: "https://api.together.xyz",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: false, streaming: true },
  },
  {
    name: "bedrock",
    displayName: "AWS Bedrock",
    keywords: [],
    envKey: "AWS_ACCESS_KEY_ID",
    defaultApiBase: "",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
  {
    name: "meta",
    displayName: "Meta AI (Llama 4)",
    keywords: ["llama4", "llama-4", "meta-llama/llama-4"],
    envKey: "META_AI_API_KEY",
    defaultApiBase: "https://api.llama.com/compat/v1",
    isLocal: false,
    capabilities: { nativeToolCalling: true, vision: true, streaming: true },
  },
] as const;

// ── Lookup Functions ─────────────────────────────────────────────────────────

/** Name index for O(1) lookups. */
const byName = new Map<string, ProviderSpec>();
for (const spec of PROVIDERS) {
  byName.set(spec.name, spec);
}

/**
 * Find a provider by its name (e.g. "anthropic", "ollama").
 */
export function findByName(name: string): ProviderSpec | undefined {
  return byName.get(name.toLowerCase());
}

/**
 * Find a provider by matching a model ID against keyword prefixes.
 *
 * For a model ID like "claude-sonnet-4", this checks if any provider's
 * keywords array has a matching prefix. Returns the first match.
 */
export function findByModel(modelId: string): ProviderSpec | undefined {
  const lower = modelId.toLowerCase();
  for (const spec of PROVIDERS) {
    for (const keyword of spec.keywords) {
      if (lower.startsWith(keyword) || lower.includes(keyword)) {
        return spec;
      }
    }
  }
  return undefined;
}

/**
 * Find a provider by its default API base URL.
 */
export function findByApiBase(baseUrl: string): ProviderSpec | undefined {
  const normalized = baseUrl.replace(/\/+$/, "").toLowerCase();
  for (const spec of PROVIDERS) {
    if (spec.defaultApiBase && spec.defaultApiBase.toLowerCase() === normalized) {
      return spec;
    }
  }
  return undefined;
}

/**
 * Get all registered providers.
 */
export function getAllProviders(): readonly ProviderSpec[] {
  return PROVIDERS;
}

/**
 * Get all local providers.
 */
export function getLocalProviders(): ProviderSpec[] {
  return PROVIDERS.filter((spec) => spec.isLocal);
}

/**
 * Check if a provider supports native tool calling.
 */
export function supportsToolCalling(providerName: string): boolean {
  const spec = findByName(providerName);
  return spec?.capabilities.nativeToolCalling ?? true; // default to true for unknown
}

/**
 * Check if a provider supports vision (image inputs).
 */
export function supportsVision(providerName: string): boolean {
  const spec = findByName(providerName);
  return spec?.capabilities.vision ?? false; // default to false for unknown
}
