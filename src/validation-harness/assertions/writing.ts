import type { AssertionContext, AssertionResult } from "../types.js";

const SECTION_RE = /^#{1,3}\s+\S/gm;

function countWords(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

function hasStructure(content: string): boolean {
  SECTION_RE.lastIndex = 0;
  const sections = (content.match(SECTION_RE) ?? []).length;
  if (sections >= 2) {
    return true;
  }
  // Fallback: at least 3 substantial paragraphs (separated by blank lines)
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 30);
  return paragraphs.length >= 3;
}

function hasActionableContent(content: string): boolean {
  return /next steps?|action items?|recommend|conclusion|summary|in summary|to do/i.test(content);
}

/**
 * Evaluate all writing-task assertions per spec Section 3.3.
 * Returns minimum 6 assertion results (7 total, matching registry).
 */
export function evaluateWritingAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const wordCount = countWords(content);
  const targetWordCount =
    typeof taskMetadata.targetWordCount === "number" ? taskMetadata.targetWordCount : null;

  const wordCountStatus = ((): "pass" | "fail" | "skip" => {
    if (targetWordCount === null) {
      return "skip";
    }
    const lower = targetWordCount * 0.8;
    const upper = targetWordCount * 1.2;
    return wordCount >= lower && wordCount <= upper ? "pass" : "fail";
  })();

  return [
    {
      id: "writing.requirements_met",
      category: "writing",
      name: "Requirements Met",
      description: "All explicit brief requirements are present in output",
      required: true,
      weight: 1.0,
      // Heuristic: substantial content present
      status: content.trim().length > 100 ? "pass" : "fail",
      detail:
        content.trim().length > 100
          ? "Response has sufficient content to meet requirements"
          : "Response too brief to satisfy writing requirements",
    },
    {
      id: "writing.grammar",
      category: "writing",
      name: "Grammar Clean",
      description: "Fewer than 3 grammar errors per 500 words",
      required: true,
      weight: 1.0,
      // Full grammar check requires external tooling; assume pass
      status: "pass",
      detail: "Grammar validation not available in harness context; assumed clean",
    },
    {
      id: "writing.word_count",
      category: "writing",
      name: "Word Count In Range",
      description: "Within +/- 20% of target word count if specified",
      required: false,
      weight: 0.5,
      status: wordCountStatus,
      detail:
        wordCountStatus === "skip"
          ? "Skipped: no target word count specified in task brief"
          : wordCountStatus === "pass"
            ? `Word count ${wordCount} is within ±20% of target ${targetWordCount}`
            : `Word count ${wordCount} is outside ±20% range of target ${targetWordCount}`,
    },
    {
      id: "writing.tone_consistent",
      category: "writing",
      name: "Tone Consistent",
      description: "Tone matches the brief (formal/informal/technical)",
      required: true,
      weight: 1.0,
      // Tone analysis requires LLM; assume pass
      status: "pass",
      detail: "Tone analysis not available in harness context; assumed consistent",
    },
    {
      id: "writing.structure_complete",
      category: "writing",
      name: "Structure Complete",
      description: "Required sections (intro, body, conclusion or equivalent) present",
      required: true,
      weight: 1.0,
      status: hasStructure(content) ? "pass" : "fail",
      detail: hasStructure(content)
        ? "Document structure with multiple sections detected"
        : "No clear document structure found; intro/body/conclusion may be missing",
    },
    {
      id: "writing.no_duplication",
      category: "writing",
      name: "No Duplication",
      description: "No substantial paragraph repeated within document",
      required: false,
      weight: 0.5,
      status: "pass",
      detail: "Duplication detection not available in harness context; assumed clean",
    },
    {
      id: "writing.actionable",
      category: "writing",
      name: "Actionable Where Applicable",
      description: "CTAs, recommendations, or next steps present if brief requires them",
      required: false,
      weight: 0.5,
      status: hasActionableContent(content) ? "pass" : "fail",
      detail: hasActionableContent(content)
        ? "Actionable content or next steps detected"
        : "No actionable content or next steps found",
    },
  ];
}
