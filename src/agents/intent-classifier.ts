/**
 * Intent classifier — routes incoming requests to the correct agent type.
 *
 * Fully stateless: no DB, no file I/O, no Node.js-only APIs.
 * Suitable for deployment as a Cloudflare Worker V8 Isolate.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentType = "chat" | "code" | "browser" | "media" | "tool" | "voice" | "unknown";

export type IntentClassifierInput = {
  /** Raw user message text. */
  message: string;
  /** Optional MIME types of attached files/media. */
  attachmentMimeTypes?: string[];
  /** Whether the session has browser access enabled. */
  hasBrowser?: boolean;
};

export type IntentClassifierResult = {
  agentType: AgentType;
  confidence: number;
  matched: string;
};

// ── Matchers ─────────────────────────────────────────────────────────────────

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

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify the intent of an incoming user message.
 *
 * Returns the most specific agent type that matches, or "chat" as the default.
 * Runs in <1ms for typical messages (no network calls, pure regex).
 */
export function classifyIntent(input: IntentClassifierInput): IntentClassifierResult {
  const { message, attachmentMimeTypes = [], hasBrowser = false } = input;

  // Media attachments take priority over text classification.
  const hasImageAttachment = attachmentMimeTypes.some((m) => m.startsWith("image/"));
  const hasVideoAttachment = attachmentMimeTypes.some((m) => m.startsWith("video/"));
  const hasAudioAttachment = attachmentMimeTypes.some((m) => m.startsWith("audio/"));

  if (hasImageAttachment || hasVideoAttachment || hasAudioAttachment) {
    return { agentType: "media", confidence: 0.95, matched: "attachment-mime" };
  }

  // Regex-based text classification (ordered by specificity).
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
