/**
 * Agent memory integration — pre/post turn middleware for knowledge graph injection.
 *
 * Two integration points:
 *
 *   Pre-turn  (buildMemoryContext):
 *     Before invoking the LLM, query the knowledge graph for entities mentioned
 *     in the user message. Return a formatted context block (capped at maxTokens).
 *     Caller injects this into the system prompt or first message.
 *
 *   Post-turn (extractAndStoreMemory):
 *     After the LLM responds, extract new entities/facts from the turn and write
 *     them to the graph. Uses an optional lightweight LLM extract function —
 *     when absent, falls back to heuristic extraction.
 *
 * All DB operations gracefully degrade when the DB is not initialised.
 * The module is dependency-injected for testability — no hard coupling to LLM APIs.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { KnowledgeGraphSession, listByType } from "../memory/knowledge-graph.js";
import type { ObjectType } from "../memory/knowledge-graph.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ExtractedItem = {
  label: string;
  type: ObjectType;
  data?: Record<string, unknown>;
};

/** Lightweight LLM function used for post-turn extraction. */
export type ExtractFn = (
  userMessage: string,
  assistantResponse: string,
) => Promise<ExtractedItem[]>;

export type MemoryContextResult = {
  /** Formatted text block for injection into system prompt or message context. */
  contextBlock: string;
  /** Estimated token count of the context block. */
  tokenCount: number;
  /** Number of memory objects referenced in the block. */
  objectCount: number;
};

export type MemoryIntegrationOptions = {
  /** Maximum token budget for the injected context block. Default: 500. */
  maxTokens?: number;
  /** Maximum number of related objects to traverse per entity. Default: 5. */
  maxRelated?: number;
};

// ── Token estimation (matches complexity-scorer heuristic: ~4 chars/token) ────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens with a try/catch boundary so a future tokenizer swap
 * (e.g. tiktoken) cannot corrupt the memory context build on bad input.
 * Falls back to a conservative over-estimate (maxTokens) so the caller
 * treats the block as too large rather than silently under-counting.
 */
function estimateTokensSafe(text: string, fallback: number): number {
  try {
    return estimateTokens(text);
  } catch {
    return fallback;
  }
}

// ── Entity mention detection ───────────────────────────────────────────────────

/**
 * Extract potential entity names mentioned in a user message.
 * Uses capitalised word sequences as a proxy for proper nouns.
 */
export function detectEntityMentions(message: string): string[] {
  const matches = message.match(/\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){0,2}\b/g) ?? [];
  const STOP_WORDS = new Set([
    "I",
    "The",
    "A",
    "An",
    "In",
    "Of",
    "To",
    "And",
    "Or",
    "For",
    "But",
    "Not",
    "With",
    "Is",
    "It",
    "If",
    "As",
    "On",
    "At",
    "My",
    "We",
    "You",
    "He",
    "She",
    "They",
    "What",
    "How",
    "Why",
    "When",
    "Where",
    "Which",
    "This",
    "That",
    "These",
    "Those",
    "Could",
    "Would",
    "Should",
    "Please",
    "Yes",
    "No",
    "Can",
    "Will",
    "Do",
    "Did",
    "Has",
    "Have",
    "Had",
    "Be",
    "Are",
    "Was",
    "Were",
    "Tell",
    "Show",
    "Give",
    "Get",
  ]);
  return [
    ...new Set(
      matches
        .map((m) => m.trim())
        .filter((m) => m.length >= 2 && !STOP_WORDS.has(m))
        .filter((m) => !/^\d+$/.test(m)),
    ),
  ];
}

// ── Pre-turn: build context block ─────────────────────────────────────────────

/**
 * Build a memory context block for injection before an LLM call.
 *
 * Queries the knowledge graph for entities mentioned in the user message.
 * Truncates to maxTokens to stay within context budget.
 * Returns an empty block when the DB is not ready.
 *
 * @example
 * const ctx = buildMemoryContext("Tell me about prod-01", { maxTokens: 500 });
 * if (ctx.contextBlock) {
 *   systemPrompt += "\n\n## Memory Context\n" + ctx.contextBlock;
 * }
 */
export function buildMemoryContext(
  userMessage: string,
  session: KnowledgeGraphSession,
  opts: MemoryIntegrationOptions = {},
): MemoryContextResult {
  const maxTokens = opts.maxTokens ?? 500;
  const maxRelated = opts.maxRelated ?? 5;

  const mentions = detectEntityMentions(userMessage);
  if (mentions.length === 0) {
    return { contextBlock: "", tokenCount: 0, objectCount: 0 };
  }

  const sections: string[] = [];
  let totalTokens = 0;
  let objectCount = 0;

  for (const mention of mentions) {
    if (totalTokens >= maxTokens) {
      break;
    }

    const entity = session.recallEntity(mention);
    if (!entity) {
      continue;
    }

    const lines: string[] = [`**${entity.label}** (${entity.type})`];
    if (Object.keys(entity.data).length > 0) {
      lines.push(`  data: ${JSON.stringify(entity.data)}`);
    }

    // One-hop relationships
    const related = session.findRelated(entity.id).slice(0, maxRelated);
    for (const r of related) {
      lines.push(`  → [${r.type}] ${r.label}`);
    }

    const block = lines.join("\n");
    const blockTokens = estimateTokensSafe(block, maxTokens);
    if (totalTokens + blockTokens > maxTokens) {
      // Try a truncated version
      const truncated = `**${entity.label}** (${entity.type})`;
      const truncTokens = estimateTokensSafe(truncated, maxTokens);
      if (totalTokens + truncTokens <= maxTokens) {
        sections.push(truncated);
        totalTokens += truncTokens;
        objectCount++;
      }
      break;
    }

    sections.push(block);
    totalTokens += blockTokens;
    objectCount += 1 + related.length;
  }

  const contextBlock = sections.join("\n\n");
  return { contextBlock, tokenCount: totalTokens, objectCount };
}

// ── Post-turn: extract and store ──────────────────────────────────────────────

/**
 * Heuristic fallback extractor — simple pattern matching when no LLM is available.
 */
function heuristicExtract(userMessage: string, assistantResponse: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const combined = `${userMessage} ${assistantResponse}`;

  // Stated facts: "X is Y", "X uses Y", "X runs on Y"
  const factPattern =
    /\b(\w[\w\s-]{1,30})\s+(?:is|are|uses|runs on|requires|supports)\s+([^.!?\n]{5,80})/gi;
  let match: RegExpExecArray | null;
  while ((match = factPattern.exec(combined)) !== null) {
    const label =
      `${match[1].trim()} ${match[0].split(/is|uses|runs on|requires|supports/)[1]?.trim() ?? ""}`.trim();
    if (label.length > 10 && label.length < 150) {
      items.push({ label, type: "fact" });
    }
  }

  // Stated preferences
  const prefPattern = /\bi\s+(prefer|always\s+use|like|want)\s+([^.!?\n]{5,100})/gi;
  while ((match = prefPattern.exec(userMessage)) !== null) {
    items.push({ label: match[0].trim(), type: "preference" });
  }

  return items.slice(0, 10);
}

/**
 * Extract new memory objects from a completed turn and write them to the graph.
 *
 * When extractFn is provided (LLM-based extraction), it's called with the turn.
 * Falls back to heuristic extraction when absent.
 *
 * Post-extracted entities are linked to any pre-existing related entities found
 * in the same message via `related_to` edges.
 *
 * @param userMessage     The user's message text
 * @param assistantResponse  The assistant's response text
 * @param extractFn       Optional LLM extraction function
 * @returns Count of objects written to the graph
 */
export async function extractAndStoreMemory(
  userMessage: string,
  assistantResponse: string,
  session: KnowledgeGraphSession,
  extractFn?: ExtractFn,
): Promise<number> {
  let items: ExtractedItem[];

  try {
    if (extractFn) {
      items = await extractFn(userMessage, assistantResponse);
    } else {
      items = heuristicExtract(userMessage, assistantResponse);
    }
  } catch {
    items = heuristicExtract(userMessage, assistantResponse);
  }

  let written = 0;

  // Find pre-existing entities mentioned in the user message for linking
  const mentions = detectEntityMentions(userMessage);
  const existingIds: string[] = [];
  for (const mention of mentions) {
    const entity = session.recallEntity(mention);
    if (entity) {
      existingIds.push(entity.id);
    }
  }

  for (const item of items) {
    if (!item.label?.trim()) {
      continue;
    }
    try {
      const id = session.remember({
        label: item.label.trim(),
        type: item.type,
        data: item.data ?? {},
      });
      if (id) {
        written++;
        if (existingIds.length > 0) {
          // Link new objects to existing context entities
          for (const existingId of existingIds.slice(0, 3)) {
            try {
              session.linkObjects(id, existingId, "related_to", 0.8);
            } catch {
              // ignore duplicate relationship errors
            }
          }
        }
      }
    } catch {
      // never crash the agent loop on memory write failure
    }
  }

  return written;
}

/**
 * Extract the text content of the last assistant message from a messages array.
 * Returns empty string if no assistant message is found.
 */
export function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") {
      continue;
    }
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b): b is { type: "text"; text: string } => b != null && b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

// ── Context summary utilities ──────────────────────────────────────────────────

/**
 * Summarise the current knowledge graph state for diagnostics.
 */
export function getMemoryStats(): Record<string, number> {
  const types: ObjectType[] = [
    "entity",
    "fact",
    "event",
    "preference",
    "task",
    "belief",
    "interaction",
    "skill",
  ];
  const stats: Record<string, number> = {};
  for (const type of types) {
    stats[type] = listByType(type).length;
  }
  stats["total"] = Object.values(stats).reduce((a, b) => a + b, 0);
  return stats;
}

// ── DD.1: Strategy Memory — task success recording ────────────────────────────

/**
 * Detect whether an assistant response signals successful task completion.
 *
 * Looks for common completion phrases. Intentionally conservative to avoid
 * false positives — only fires on unambiguous success language.
 */
export function detectTaskSuccess(assistantResponse: string): boolean {
  if (!assistantResponse || assistantResponse.length < 10) {
    return false;
  }
  const SUCCESS_PATTERNS: RegExp[] = [
    /\b(?:all\s+)?done[.!]?\s*$/im,
    /\b(?:task|implementation|feature|fix|refactor|migration)\s+(?:is\s+)?(?:complete|completed|finished|done)\b/i,
    /\bsuccessfully\s+(?:implemented|created|refactored|migrated|updated|added|fixed)\b/i,
    /\b(?:i've|i have)\s+(?:completed?|finished?|implemented?|created?|added?|fixed?)\b/i,
    /\bhere(?:'s| is) the (?:complete|final|finished|updated)\b/i,
  ];
  return SUCCESS_PATTERNS.some((p) => p.test(assistantResponse));
}

/**
 * Record a successful task as a `Skill` memory object in the knowledge graph.
 *
 * Called from the post-turn hook when a success signal is detected.
 * Stores the task description, tool sequence, and outcome as a searchable
 * `skill` memory object. Future tasks of the same type can retrieve this
 * via `searchFacts({ query: taskType, type: "skill" })`.
 *
 * @param taskDescription  Short description of what was accomplished
 * @param toolSequence     Ordered list of tool names used (can be empty)
 * @param session          Active knowledge graph session
 * @returns The id of the created memory object, or undefined on failure
 */
export function recordSkillSuccess(params: {
  taskDescription: string;
  toolSequence: string[];
  session: KnowledgeGraphSession;
}): string | undefined {
  const { taskDescription, toolSequence, session } = params;

  if (!taskDescription.trim()) {
    return undefined;
  }

  // Derive a slug-style task type label for FTS5 retrieval
  const taskType = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);

  try {
    const id = session.remember({
      label: taskType,
      type: "skill",
      data: {
        contextSummary: taskDescription.slice(0, 300),
        toolSequence: toolSequence.slice(0, 20),
        outcomeQuality: 0.8, // auto-scored confidence
        recordedAt: new Date().toISOString(),
      },
    });
    return id ?? undefined;
  } catch {
    // Never crash the agent loop on memory write failure
    return undefined;
  }
}
