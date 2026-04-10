/**
 * Cloudflare Worker — Response Formatter
 *
 * Normalizes raw Anthropic/OpenAI agent output to the canonical MINION
 * API response schema. Deployed as a V8 Isolate; no Node.js APIs used.
 *
 * POST /format
 * Body: raw agent output (Anthropic Messages or OpenAI Chat Completions format)
 *
 * Response: NormalizedResponse
 */

// ── Inlined formatter (no module imports in Worker bundle) ────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "image"; source: { type: "url"; url: string } };

type NormalizedResponse = {
  id: string;
  object: "chat.completion";
  model: string;
  content: ContentBlock[];
  text: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
};

type RawOutput = Record<string, unknown>;

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
    const message = isRecord(choice.message)
      ? choice.message
      : isRecord(choice.delta)
        ? choice.delta
        : null;
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
        let input: unknown = {};
        if (typeof tc.function.arguments === "string") {
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
        } else {
          input = tc.function.arguments ?? {};
        }
        blocks.push({
          type: "tool_use",
          id: typeof tc.id === "string" ? tc.id : crypto.randomUUID(),
          name: typeof tc.function.name === "string" ? tc.function.name : "unknown",
          input,
        });
      }
    }
  }
  return blocks;
}

function resolveFinishReason(raw: RawOutput, blocks: ContentBlock[]): string {
  const reason = (raw.stop_reason ?? raw.finish_reason) as string | undefined;
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

function formatResponse(raw: RawOutput): NormalizedResponse {
  let blocks: ContentBlock[] = [];

  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      const block = normalizeContentBlock(item);
      if (block) {
        blocks.push(block);
      }
    }
  }
  if (Array.isArray(raw.choices) && raw.choices.length > 0) {
    blocks = normalizeOpenAIChoices(raw.choices);
  }
  if (blocks.length === 0 && typeof raw.text === "string") {
    blocks.push({ type: "text", text: raw.text });
  }

  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const usage = isRecord(raw.usage) ? raw.usage : {};
  const inputTokens = (usage.input_tokens ?? usage.prompt_tokens ?? 0) as number;
  const outputTokens = (usage.output_tokens ?? usage.completion_tokens ?? 0) as number;

  return {
    id: typeof raw.id === "string" ? raw.id : `resp_${crypto.randomUUID()}`,
    object: "chat.completion",
    model: typeof raw.model === "string" ? raw.model : "unknown",
    content: blocks,
    text,
    finishReason: resolveFinishReason(raw, blocks),
    usage: { inputTokens, outputTokens },
  };
}

// ── Worker export ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, worker: "response-formatter" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: RawOutput;
    try {
      body = (await request.json()) as RawOutput;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!isRecord(body)) {
      return new Response(JSON.stringify({ error: "Body must be a JSON object" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = formatResponse(body);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
