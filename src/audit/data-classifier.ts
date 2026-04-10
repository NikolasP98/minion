/**
 * Data category classifier for AudAgent.
 *
 * Classifies params/result objects into DataCategory[] using field-name
 * pattern matching. Traverses nested objects and arrays recursively.
 */

import type { DataCategory } from "./audit-types.js";

type PatternRule = {
  pattern: RegExp;
  category: DataCategory;
};

// Ordered: more-specific patterns checked before more-general ones.
const FIELD_RULES: PatternRule[] = [
  // credentials — check before user_content to avoid key/token ambiguity
  {
    pattern:
      /\b(token|key|secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b/i,
    category: "credentials",
  },
  // health_info (PHI — HIPAA)
  {
    pattern:
      /\b(diagnosis|medical|health|prescription|medication|condition|symptom|treatment|insurance[_-]?id|patient[_-]?id|mrn|npi|icd[_-]?code|procedure[_-]?code|lab[_-]?result|allergy|immunization|vital[_-]?sign)\b/i,
    category: "health_info",
  },
  // financial_info (PCI-DSS)
  {
    pattern:
      /\b(credit[_-]?card|card[_-]?number|cvv|cvc|expiry|bank[_-]?account|routing[_-]?number|iban|swift|ssn|social[_-]?security|tin|tax[_-]?id|transaction|payment|billing[_-]?amount|balance|account[_-]?number)\b/i,
    category: "financial_info",
  },
  // user_identity
  {
    pattern:
      /\b(email|phone|name|user[_-]?id|sender[_-]?id|author[_-]?id|account[_-]?id|username|user[_-]?name|firstname|lastname|fullname)\b/i,
    category: "user_identity",
  },
  // user_location
  {
    pattern:
      /\b(lat(itude)?|lng|lon(gitude)?|location|address|ip([_-]?addr(ess)?)?|geo|gps|region|city|country|zipcode|postcode)\b/i,
    category: "user_location",
  },
  // message_history — "messages" (plural) is history; singular "message" maps to user_content below
  {
    pattern: /\b(history|messages|context|thread|conversation|chat[_-]?log|transcript)\b/i,
    category: "message_history",
  },
  // file_content
  {
    pattern: /\b(file|path|document|upload|attachment|blob|buffer)\b/i,
    category: "file_content",
  },
  // user_content — broad, comes after more-specific patterns
  {
    pattern: /\b(body|text|message|content|query|input|prompt|request|payload)\b/i,
    category: "user_content",
  },
];

function classifyKey(key: string): DataCategory | null {
  for (const rule of FIELD_RULES) {
    if (rule.pattern.test(key)) {
      return rule.category;
    }
  }
  return null;
}

function collectKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return prefix ? [prefix] : [];
  }
  if (Array.isArray(value)) {
    const keys: string[] = [];
    for (let i = 0; i < value.length; i++) {
      keys.push(...collectKeys(value[i], prefix ? `${prefix}[${i}]` : `[${i}]`));
    }
    return keys;
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    // Classify the key itself
    keys.push(fullKey);
    // Also recurse into nested objects/arrays
    keys.push(...collectKeys(v, fullKey));
  }
  return keys;
}

/**
 * Classify a params/result object into zero or more DataCategory values.
 *
 * Each key (and nested key) is tested against the field-name pattern rules.
 * Duplicates are eliminated; order is stable (follows FIELD_RULES order).
 */
export function classifyParams(params: Record<string, unknown>): DataCategory[] {
  const found = new Set<DataCategory>();

  const allKeys = collectKeys(params);
  for (const fullKey of allKeys) {
    // Use the last segment of a dotted key for pattern matching
    const leaf =
      fullKey
        .split(/[.[\]]+/)
        .filter(Boolean)
        .at(-1) ?? fullKey;
    const category = classifyKey(leaf);
    if (category !== null) {
      found.add(category);
    }
  }

  // Return in FIELD_RULES order for stable output
  return FIELD_RULES.map((r) => r.category).filter((c) => found.has(c));
}
