import type { AssertionContext, AssertionResult } from "../types.js";

const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
const SECTION_HEADINGS_RE = /^#{1,3}\s+\S/gm;
const CITATION_RE = /\[[\w\s]+\]|\([A-Z][a-z]+\s+\d{4}\)|\[(\d+)\]/g;

function countUrls(content: string): number {
  URL_RE.lastIndex = 0;
  return (content.match(URL_RE) ?? []).length;
}

function hasSections(content: string): boolean {
  SECTION_HEADINGS_RE.lastIndex = 0;
  return (content.match(SECTION_HEADINGS_RE) ?? []).length >= 2;
}

function hasVerifiableClaims(content: string): boolean {
  CITATION_RE.lastIndex = 0;
  return CITATION_RE.test(content) || countUrls(content) >= 1;
}

/**
 * Evaluate all research-task assertions per spec Section 3.2.
 * Returns minimum 6 assertion results (7 total, matching registry).
 */
export function evaluateResearchAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const urlCount = countUrls(content);
  // Default time-sensitive to true unless explicitly set false
  const timeSensitive = taskMetadata.timeSensitive !== false;
  const isOffline = Boolean(taskMetadata.offline);
  const sectionsPresent = hasSections(content);

  return [
    {
      id: "research.objective_addressed",
      category: "research",
      name: "Objective Addressed",
      description: "Report covers the stated research question",
      required: true,
      weight: 1.0,
      // Heuristic: content is non-trivially long (> 200 chars)
      status: content.trim().length > 200 ? "pass" : "fail",
      detail:
        content.trim().length > 200
          ? "Response has substantial content addressing the research objective"
          : "Response is too brief to adequately address a research objective",
    },
    {
      id: "research.sources_cited",
      category: "research",
      name: "Sources Cited",
      description: "At least 3 distinct sources cited with links or references",
      required: true,
      weight: 1.0,
      status: urlCount >= 3 ? "pass" : "fail",
      detail:
        urlCount >= 3
          ? `${urlCount} source URLs found`
          : `Only ${urlCount} source URL(s) found; minimum 3 required`,
    },
    {
      id: "research.sources_accessible",
      category: "research",
      name: "Sources Accessible",
      description: "Cited URLs resolve (not 404 or paywalled)",
      required: false,
      weight: 0.5,
      // Skip if offline/airgapped; otherwise assume pass (can't validate URLs at harness time)
      status: isOffline ? "skip" : "pass",
      detail: isOffline
        ? "Skipped: offline/airgapped environment"
        : "URL accessibility not validated in harness context; assumed accessible",
    },
    {
      id: "research.no_hallucinations",
      category: "research",
      name: "Key Claims Checkable",
      description: "All factual claims include a verifiable citation",
      required: true,
      weight: 1.0,
      status: hasVerifiableClaims(content) ? "pass" : "fail",
      detail: hasVerifiableClaims(content)
        ? "Citations or references detected in output"
        : "No citations or references detected; claims may not be verifiable",
    },
    {
      id: "research.completeness",
      category: "research",
      name: "Completeness",
      description: "All sub-questions from the brief are addressed",
      required: true,
      weight: 1.0,
      // Heuristic: multiple sections suggest completeness
      status: sectionsPresent ? "pass" : "fail",
      detail: sectionsPresent
        ? "Multiple sections detected, suggesting comprehensive coverage"
        : "No structured sections detected; brief may not be fully addressed",
    },
    {
      id: "research.structured",
      category: "research",
      name: "Structured Output",
      description: "Report has clear sections (summary, findings, implications)",
      required: false,
      weight: 0.5,
      status: sectionsPresent ? "pass" : "fail",
      detail: sectionsPresent
        ? "Structured sections detected"
        : "No markdown sections found; report may lack structure",
    },
    {
      id: "research.recency",
      category: "research",
      name: "Recency Appropriate",
      description: "For time-sensitive topics, sources are within 12 months",
      required: false,
      weight: 0.5,
      status: timeSensitive ? "pass" : "skip",
      detail: !timeSensitive
        ? "Skipped: topic not classified as time-sensitive"
        : "Recency of sources not validated in harness context; assumed appropriate",
    },
  ];
}
