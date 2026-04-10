/**
 * LLM-driven memory consolidation.
 *
 * Reads accumulated daily notes (memory/YYYY-MM-DD.md) and asks an LLM to
 * produce a consolidated summary. The summary is merged into MEMORY.md
 * and a history entry is appended to memory/history/YYYY-MM-DD.md.
 *
 * Runs asynchronously and non-blocking — should never delay the user's
 * next message.
 *
 * Inspired by Nanobot's memory consolidation pattern.
 *
 * @module
 */

import fs from "node:fs/promises";
import path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type ConsolidationConfig = {
  /** Enable automatic consolidation (default: false). */
  enabled?: boolean;
  /** Number of daily note files to accumulate before triggering (default: 7). */
  fileThreshold?: number;
  /** Max chars to read from daily notes per consolidation run (default: 16000). */
  maxInputChars?: number;
};

export type ConsolidationResult = {
  status: "skipped" | "consolidated" | "error";
  filesProcessed?: number;
  reason?: string;
};

type LlmCallFn = (prompt: string, systemPrompt: string) => Promise<string>;

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FILE_THRESHOLD = 7;
const DEFAULT_MAX_INPUT_CHARS = 16_000;

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation agent. Your job is to process daily notes and produce a concise, organized long-term memory update.`;

const CONSOLIDATION_PROMPT_TEMPLATE = `Process these daily notes and return a JSON object with exactly two keys:
1. "history_entry": A paragraph summarizing the key events, decisions, and topics across these notes.
2. "memory_update": The updated long-term memory content. Merge new facts into the existing memory below. Remove duplicates. Keep it concise and well-organized.

## Current Long-term Memory (MEMORY.md)
{current_memory}

## Daily Notes to Consolidate
{daily_notes}

Respond with ONLY valid JSON, no markdown fences.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

const DATED_NOTE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

async function listDailyNotes(memoryDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(memoryDir);
    return entries.filter((name) => DATED_NOTE_RE.test(name)).toSorted(); // chronological order
  } catch {
    return [];
  }
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function parseConsolidationResponse(raw: string): {
  history_entry: string;
  memory_update: string;
} | null {
  // Strip markdown fences if present (despite our instruction)
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.history_entry === "string" &&
      typeof parsed.memory_update === "string"
    ) {
      return parsed as { history_entry: string; memory_update: string };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Check if consolidation should run based on accumulated daily notes.
 */
export async function shouldConsolidate(params: {
  workspaceDir: string;
  config?: ConsolidationConfig;
}): Promise<{ should: boolean; noteCount: number }> {
  if (!params.config?.enabled) {
    return { should: false, noteCount: 0 };
  }
  const threshold = params.config.fileThreshold ?? DEFAULT_FILE_THRESHOLD;
  const memoryDir = path.join(params.workspaceDir, "memory");
  const notes = await listDailyNotes(memoryDir);
  return { should: notes.length >= threshold, noteCount: notes.length };
}

/**
 * Run memory consolidation.
 *
 * Reads daily notes, calls the LLM to produce a consolidated summary,
 * updates MEMORY.md, and appends a history entry. Processed notes are
 * moved to memory/archive/ to prevent re-processing.
 */
export async function consolidateMemory(params: {
  workspaceDir: string;
  config?: ConsolidationConfig;
  callLlm: LlmCallFn;
}): Promise<ConsolidationResult> {
  const { workspaceDir, config, callLlm } = params;
  const maxInputChars = config?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const memoryDir = path.join(workspaceDir, "memory");
  const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
  const archiveDir = path.join(memoryDir, "archive");

  // 1. List daily notes
  const noteFiles = await listDailyNotes(memoryDir);
  if (noteFiles.length === 0) {
    return { status: "skipped", reason: "no daily notes found" };
  }

  // 2. Read daily notes (truncate at budget)
  // Each file is capped at the remaining char budget. If a single file exceeds the
  // entire budget it is truncated rather than skipped — ensuring at least one note
  // is always processed when notes exist.
  let totalChars = 0;
  const noteContents: string[] = [];
  const processedFiles: string[] = [];
  for (const fileName of noteFiles) {
    const remaining = maxInputChars - totalChars;
    if (remaining <= 0) {
      break;
    }
    const content = await readFileSafe(path.join(memoryDir, fileName));
    if (!content.trim()) {
      continue;
    }
    // Cap this file's contribution to the remaining budget.
    const chunk = content.length > remaining ? content.slice(0, remaining) : content;
    if (!chunk.trim()) {
      continue;
    }
    noteContents.push(`### ${fileName}\n${chunk}`);
    processedFiles.push(fileName);
    totalChars += chunk.length;
    if (content.length > remaining) {
      // Budget exhausted after this file; stop processing further files.
      break;
    }
  }

  if (noteContents.length === 0) {
    return { status: "skipped", reason: "all daily notes are empty" };
  }

  // 3. Read current MEMORY.md
  const currentMemory = await readFileSafe(memoryMdPath);

  // 4. Build prompt
  const prompt = CONSOLIDATION_PROMPT_TEMPLATE.replace(
    "{current_memory}",
    currentMemory || "(empty)",
  ).replace("{daily_notes}", noteContents.join("\n\n"));

  // 5. Call LLM
  let response: string;
  try {
    response = await callLlm(prompt, CONSOLIDATION_SYSTEM_PROMPT);
  } catch (err) {
    return { status: "error", reason: `LLM call failed: ${String(err)}` };
  }

  // 6. Parse response
  const parsed = parseConsolidationResponse(response);
  if (!parsed) {
    return { status: "error", reason: "Failed to parse LLM consolidation response as JSON" };
  }

  // 7. Write updated MEMORY.md
  try {
    await fs.writeFile(memoryMdPath, parsed.memory_update, "utf-8");
  } catch (err) {
    return { status: "error", reason: `Failed to write MEMORY.md: ${String(err)}` };
  }

  // 8. Append history entry
  try {
    const historyDir = path.join(memoryDir, "history");
    await fs.mkdir(historyDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const historyPath = path.join(historyDir, `${today}.md`);
    const timestamp = new Date().toISOString();
    const entry = `\n## Consolidation at ${timestamp}\n\n${parsed.history_entry}\n\n---\n`;
    await fs.appendFile(historyPath, entry, "utf-8");
  } catch {
    // Non-fatal — history append failure shouldn't block consolidation
  }

  // 9. Archive processed notes
  try {
    await fs.mkdir(archiveDir, { recursive: true });
    for (const fileName of processedFiles) {
      const src = path.join(memoryDir, fileName);
      const dst = path.join(archiveDir, fileName);
      await fs.rename(src, dst);
    }
  } catch {
    // Non-fatal — archive failure shouldn't block
  }

  return {
    status: "consolidated",
    filesProcessed: processedFiles.length,
  };
}
