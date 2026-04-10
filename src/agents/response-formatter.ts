/**
 * Response formatter — normalizes agent output to the API response schema.
 *
 * Fully stateless: no DB, no file I/O, no Node.js-only APIs.
 * Suitable for deployment as a Cloudflare Worker V8 Isolate.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "image"; source: { type: "url"; url: string } };

export type NormalizedResponse = {
  id: string;
  object: "chat.completion";
  model: string;
  content: ContentBlock[];
  /** Concatenated text from all text blocks. */
  text: string;
  /** Finish reason: "stop" | "tool_calls" | "length" | "error" */
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};

export type RawAgentOutput = {
  id?: string;
  model?: string;
  content?: unknown;
  stop_reason?: string;
  finish_reason?: string;
  choices?: unknown[];
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeContentBlock(raw: unknown): ContentBlock | null {
  if (!isRecord(raw)) {
    return null;
  }
  const type = raw.type;

  if (type === "text" && typeof raw.text === "string") {
    return { type: "text", text: raw.text };
  }
  if (type === "tool_use" && typeof raw.id === "string" && typeof raw.name === "string") {
    return { type: "tool_use", id: raw.id, name: raw.name, input: raw.input ?? {} };
  }
  if (type === "tool_result" && typeof raw.tool_use_id === "string") {
    const content =
      typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content ?? "");
    return { type: "tool_result", tool_use_id: raw.tool_use_id, content };
  }
  if (type === "image" && isRecord(raw.source) && typeof raw.source.url === "string") {
    return { type: "image", source: { type: "url", url: raw.source.url } };
  }
  return null;
}

function normalizeOpenAIChoices(choices: unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : choice.delta;
    if (!isRecord(message)) {
      continue;
    }

    if (typeof message.content === "string" && message.content) {
      blocks.push({ type: "text", text: message.content });
    }

    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (!isRecord(tc) || !isRecord(tc.function)) {
          continue;
        }
        blocks.push({
          type: "tool_use",
          id: typeof tc.id === "string" ? tc.id : crypto.randomUUID(),
          name: typeof tc.function.name === "string" ? tc.function.name : "unknown",
          input:
            typeof tc.function.arguments === "string"
              ? (() => {
                  try {
                    return JSON.parse(tc.function.arguments);
                  } catch {
                    return {};
                  }
                })()
              : (tc.function.arguments ?? {}),
        });
      }
    }
  }
  return blocks;
}

function resolveFinishReason(raw: RawAgentOutput, blocks: ContentBlock[]): string {
  const reason = raw.stop_reason ?? raw.finish_reason;
  if (reason === "tool_use" || reason === "tool_calls") {
    return "tool_calls";
  }
  if (reason === "end_turn" || reason === "stop") {
    return "stop";
  }
  if (reason === "max_tokens" || reason === "length") {
    return "length";
  }
  if (blocks.some((b) => b.type === "tool_use")) {
    return "tool_calls";
  }
  return "stop";
}

// ── Formatter ─────────────────────────────────────────────────────────────────

let _idCounter = 0;

function nextId(): string {
  // Use crypto.randomUUID if available (Workers + Node 19+), otherwise increment counter.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `resp_${crypto.randomUUID()}`;
  }
  return `resp_${Date.now()}_${(_idCounter += 1)}`;
}

/**
 * Normalize raw agent output (Anthropic or OpenAI format) into a
 * canonical NormalizedResponse suitable for the MINION API.
 *
 * Pure transformation — no I/O, no side effects.
 */
export function formatResponse(raw: RawAgentOutput): NormalizedResponse {
  let blocks: ContentBlock[] = [];

  // Anthropic-style content array
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      const block = normalizeContentBlock(item);
      if (block) {
        blocks.push(block);
      }
    }
  }
  // OpenAI-style choices array (takes precedence if both present)
  if (Array.isArray(raw.choices) && raw.choices.length > 0) {
    blocks = normalizeOpenAIChoices(raw.choices);
  }
  // Flat string fallback
  if (
    blocks.length === 0 &&
    isRecord(raw) &&
    typeof (raw as Record<string, unknown>).text === "string"
  ) {
    blocks.push({ type: "text", text: (raw as Record<string, unknown>).text as string });
  }

  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const usage = raw.usage ?? {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;

  return {
    id: typeof raw.id === "string" ? raw.id : nextId(),
    object: "chat.completion",
    model: typeof raw.model === "string" ? raw.model : "unknown",
    content: blocks,
    text,
    finishReason: resolveFinishReason(raw, blocks),
    usage: { inputTokens, outputTokens },
  };
}
