/**
 * Cloudflare Worker — Intent Classifier
 *
 * Classifies incoming user messages to the correct MINION agent type.
 * Deployed as a V8 Isolate; no Node.js APIs used.
 *
 * POST /classify
 * Body: { message: string, attachmentMimeTypes?: string[], hasBrowser?: boolean }
 *
 * Response: { agentType, confidence, matched }
 */

// ── Inlined classifier (no module imports in Worker bundle) ───────────────────

type AgentType = "chat" | "code" | "browser" | "media" | "tool" | "voice" | "unknown";

type IntentClassifierResult = {
  agentType: AgentType;
  confidence: number;
  matched: string;
};

const CODE_PATTERNS = [
  /\b(write|fix|debug|refactor|implement|test|build|compile|run)\b.{0,60}\b(code|function|class|script|program|module|component|api|endpoint)\b/i,
  /```[\s\S]/,
  /\b(typescript|javascript|python|rust|go|java|c\+\+|sql)\b/i,
  /\b(npm|pnpm|yarn|cargo|pip|gradle)\b/i,
];

const BROWSER_PATTERNS = [
  /\b(browse|navigate|open|visit|go to|search|scrape|screenshot|click)\b/i,
  /https?:\/\//i,
  /\b(website|webpage|url|link|page)\b/i,
];

const MEDIA_PATTERNS = [
  /\b(image|photo|picture|video|audio|transcribe|describe|analyze)\b/i,
  /\b(draw|generate|create).{0,30}\b(image|picture|graphic|art)\b/i,
];

const VOICE_PATTERNS = [/\b(speak|say|voice|tts|text.to.speech|read.out.loud|dictate)\b/i];

const TOOL_PATTERNS = [
  /\b(call|invoke|execute|run|trigger)\b.{0,40}\b(tool|function|action|command)\b/i,
  /\b(get|fetch|post|put|delete)\b.{0,40}\b(api|endpoint|url|request)\b/i,
];

function classifyIntent(
  message: string,
  attachmentMimeTypes: string[],
  hasBrowser: boolean,
): IntentClassifierResult {
  const hasImageAttachment = attachmentMimeTypes.some((m) => m.startsWith("image/"));
  const hasVideoAttachment = attachmentMimeTypes.some((m) => m.startsWith("video/"));
  const hasAudioAttachment = attachmentMimeTypes.some((m) => m.startsWith("audio/"));

  if (hasImageAttachment || hasVideoAttachment || hasAudioAttachment) {
    return { agentType: "media", confidence: 0.95, matched: "attachment-mime" };
  }

  for (const pattern of VOICE_PATTERNS) {
    if (pattern.test(message)) {
      return { agentType: "voice", confidence: 0.85, matched: pattern.source };
    }
  }
  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(message)) {
      return { agentType: "code", confidence: 0.9, matched: pattern.source };
    }
  }
  if (hasBrowser) {
    for (const pattern of BROWSER_PATTERNS) {
      if (pattern.test(message)) {
        return { agentType: "browser", confidence: 0.88, matched: pattern.source };
      }
    }
  }
  for (const pattern of TOOL_PATTERNS) {
    if (pattern.test(message)) {
      return { agentType: "tool", confidence: 0.8, matched: pattern.source };
    }
  }
  for (const pattern of MEDIA_PATTERNS) {
    if (pattern.test(message)) {
      return { agentType: "media", confidence: 0.75, matched: pattern.source };
    }
  }
  return { agentType: "chat", confidence: 0.6, matched: "default" };
}

// ── Worker export ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, worker: "intent-classifier" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      return new Response(JSON.stringify({ error: "message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const attachmentMimeTypes = Array.isArray(body.attachmentMimeTypes)
      ? (body.attachmentMimeTypes as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const hasBrowser = body.hasBrowser === true;

    const result = classifyIntent(message, attachmentMimeTypes, hasBrowser);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
