/**
 * HTTP response credential leak detection.
 *
 * Scans HTTP tool response bodies for credential patterns before the content
 * is returned to the agent/LLM. Redacts matches to prevent:
 * - Prompt injection attacks that embed stolen credentials in HTTP responses
 * - Accidental leakage of API keys, tokens, or secrets via fetched web pages
 *
 * Inspired by IronClaw's `src/safety/leak_detector.rs`.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/leak-detector");

// ── Credential patterns ──────────────────────────────────────────────

interface CredentialPattern {
  name: string;
  pattern: RegExp;
}

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  // Anthropic API keys
  { name: "anthropic-api-key", pattern: /sk-ant-[A-Za-z0-9_-]{40,}/g },

  // OpenAI API keys
  { name: "openai-api-key", pattern: /sk-[A-Za-z0-9]{20,}/g },

  // GitHub tokens (classic and fine-grained)
  { name: "github-pat", pattern: /ghp_[A-Za-z0-9]{36,}/g },
  { name: "github-secret", pattern: /ghs_[A-Za-z0-9]{36,}/g },
  { name: "github-oauth", pattern: /gho_[A-Za-z0-9]{36,}/g },
  { name: "github-user-to-server", pattern: /ghu_[A-Za-z0-9]{36,}/g },

  // AWS access keys
  { name: "aws-access-key", pattern: /AKIA[A-Z0-9]{16}/g },
  {
    name: "aws-secret-key",
    pattern: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
  },

  // Bearer tokens in JSON/headers (long enough to be real)
  { name: "bearer-token", pattern: /[Bb]earer\s+[A-Za-z0-9._-]{30,}/g },

  // Google API keys
  { name: "google-api-key", pattern: /AIza[A-Za-z0-9_-]{35}/g },

  // Google OAuth tokens
  { name: "google-oauth", pattern: /ya29\.[A-Za-z0-9._-]{20,}/g },

  // Slack tokens
  { name: "slack-token", pattern: /xox[bprs]-[A-Za-z0-9-]{10,}/g },

  // Stripe keys
  { name: "stripe-key", pattern: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{20,}/g },

  // SendGrid API keys
  { name: "sendgrid-key", pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },

  // Twilio
  { name: "twilio-key", pattern: /SK[a-f0-9]{32}/g },

  // Telegram bot tokens
  { name: "telegram-bot-token", pattern: /[0-9]{8,12}:[A-Za-z0-9_-]{35}/g },

  // Discord bot tokens (base64-encoded user ID + timestamp + HMAC)
  {
    name: "discord-token",
    pattern: /[MN][A-Za-z0-9]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
  },

  // Generic "api_key" / "apiKey" / "api-key" in JSON-like context
  {
    name: "generic-api-key",
    pattern:
      /["']?(?:api[-_]?key|apikey|api[-_]?secret|secret[-_]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{20,}["']?/gi,
  },

  // Private keys (PEM)
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },

  // Connection strings with credentials
  {
    name: "connection-string",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
  },
];

// ── Public API ───────────────────────────────────────────────────────

export interface LeakScanResult {
  /** Whether any credentials were detected. */
  hasLeaks: boolean;
  /** Redacted version of the content (credentials replaced). */
  redacted: string;
  /** Number of credentials found. */
  count: number;
  /** Names of the pattern types that matched. */
  matchedPatterns: string[];
}

/**
 * Attempt to percent-decode content before scanning.
 *
 * Credentials can be percent-encoded to evade regex patterns:
 * e.g., `sk%2Dant%2Dapi03%2D...` evades `/sk-ant-/` matching.
 * Decoding before scanning closes this bypass class.
 *
 * Returns decoded content, or the original if decoding fails/changes nothing.
 */
function tryPercentDecode(input: string): string {
  if (!input.includes("%")) {
    return input;
  }
  try {
    const decoded = decodeURIComponent(input);
    return decoded;
  } catch {
    // Invalid percent sequences (e.g., incomplete `%2` at end) — return original.
    return input;
  }
}

/**
 * Scan content for credential patterns and redact them.
 *
 * Scans both the raw content and a percent-decoded version to catch
 * credentials that are URL-encoded to bypass plain-text pattern matching.
 *
 * Returns the redacted content and metadata about what was found.
 * The redaction marker includes the pattern name for auditability.
 */
export function scanAndRedact(content: string): LeakScanResult {
  if (!content) {
    return { hasLeaks: false, redacted: content, count: 0, matchedPatterns: [] };
  }

  // Decode percent-encoded sequences before scanning. Attackers can encode
  // credentials (e.g., `sk%2Dant%2D...`) to evade literal pattern matching.
  // We scan the decoded form and return decoded-and-redacted content so the
  // LLM never sees either the encoded or decoded credential.
  const normalized = tryPercentDecode(content);

  let redacted = normalized;
  let count = 0;
  const matchedPatterns: string[] = [];

  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global regexes.
    pattern.lastIndex = 0;
    const matches = redacted.match(pattern);
    if (matches && matches.length > 0) {
      count += matches.length;
      if (!matchedPatterns.includes(name)) {
        matchedPatterns.push(name);
      }
      // Reset and replace.
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, `[REDACTED:${name}]`);
    }
  }

  if (count > 0) {
    log.debug(`Credential leak scan: ${count} match(es) redacted [${matchedPatterns.join(", ")}]`);
  }

  return {
    hasLeaks: count > 0,
    redacted,
    count,
    matchedPatterns,
  };
}

/**
 * Quick check: does the content contain any credential patterns?
 * Cheaper than full scan+redact when you just need a boolean.
 * Also checks percent-decoded form to catch encoded bypass attempts.
 */
export function hasCredentialPatterns(content: string): boolean {
  if (!content) {
    return false;
  }
  const normalized = tryPercentDecode(content);
  for (const { pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}
