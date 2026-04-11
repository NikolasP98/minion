/**
 * Llama 4 Maverick provider — Phase 1 (Meta AI hosted API).
 *
 * Implements text reasoning and vision (image understanding) via the Meta AI
 * REST API (OpenAI-compatible endpoint). Groq's Llama 4 endpoint is used as
 * a fallback when `META_AI_API_KEY` is not set but `GROQ_API_KEY` is.
 *
 * Feature flag:
 *   LLAMA4_MAVERICK_ENABLED=false   — set to true to enable (default: false)
 *
 * Required env:
 *   META_AI_API_KEY                 — API key for api.llama.com
 *   GROQ_API_KEY                    — fallback when Meta key not available
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ModelProvider {
  /** Complete a text prompt and return the assistant response text. */
  complete(prompt: string, opts?: CompletionOptions): Promise<string>;
}

export interface VisionModelProvider extends ModelProvider {
  /** Describe or answer a question about a base64-encoded image. */
  processImage(base64: string, prompt: string): Promise<string>;
}

export interface CompletionOptions {
  /** System prompt to prepend. */
  system?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature (0–1). */
  temperature?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const LLAMA4_MAVERICK_MODEL = "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8";
export const META_AI_API_BASE = "https://api.llama.com/compat/v1";
export const GROQ_LLAMA4_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
export const GROQ_API_BASE = "https://api.groq.com/openai/v1";
export const DEFAULT_MAX_TOKENS = 2048;

// ── OpenAI-compatible request/response types ──────────────────────────────────

type ChatMessage =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: string | ContentPart[] };

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatCompletionResponse = {
  choices: Array<{
    message: { content: string | null };
  }>;
  error?: { message: string };
};

// ── Implementation ────────────────────────────────────────────────────────────

export class Llama4MaverickProvider implements VisionModelProvider {
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; apiBase?: string; model?: string }) {
    const metaKey = opts?.apiKey ?? process.env.META_AI_API_KEY ?? "";
    const groqKey = process.env.GROQ_API_KEY ?? "";

    if (metaKey) {
      this.apiKey = metaKey;
      this.apiBase = opts?.apiBase ?? META_AI_API_BASE;
      this.model = opts?.model ?? LLAMA4_MAVERICK_MODEL;
    } else if (groqKey) {
      this.apiKey = groqKey;
      this.apiBase = GROQ_API_BASE;
      this.model = GROQ_LLAMA4_MODEL;
    } else {
      throw new Error(
        "Llama4MaverickProvider requires META_AI_API_KEY or GROQ_API_KEY to be set.",
      );
    }
  }

  async complete(prompt: string, opts?: CompletionOptions): Promise<string> {
    const messages: ChatMessage[] = [];
    if (opts?.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: prompt });
    return this.chatComplete(messages, opts);
  }

  async processImage(base64: string, prompt: string): Promise<string> {
    const dataUrl = base64.startsWith("data:") ? base64 : `data:image/jpeg;base64,${base64}`;
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: prompt },
        ],
      },
    ];
    return this.chatComplete(messages);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async chatComplete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string> {
    const body = {
      model: this.model,
      messages,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    const resp = await fetch(`${this.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Llama4MaverickProvider HTTP ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as ChatCompletionResponse;
    if (data.error) {
      throw new Error(`Llama4MaverickProvider API error: ${data.error.message}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Llama4MaverickProvider: empty response from API");
    }
    return content;
  }
}

// ── Feature flag ──────────────────────────────────────────────────────────────

/**
 * Returns true when LLAMA4_MAVERICK_ENABLED is set to "true" or "1".
 * Defaults to false — opt-in required.
 */
export function isLlama4MaverickEnabled(): boolean {
  const v = process.env.LLAMA4_MAVERICK_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Returns a configured Llama4MaverickProvider instance, or null if the feature
 * is disabled or no API key is available.
 */
export function resolveDefaultLlama4Provider(): Llama4MaverickProvider | null {
  if (!isLlama4MaverickEnabled()) {
    return null;
  }
  try {
    return new Llama4MaverickProvider();
  } catch {
    return null;
  }
}
