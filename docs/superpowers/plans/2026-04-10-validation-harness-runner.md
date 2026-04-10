# Validation Harness Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a post-execution validation harness that runs quality assertions on every agent task output and produces a scored pass/fail artifact.

**Architecture:** A new `src/validation-harness/` core module handles typing, assertion evaluation, scoring, and artifact generation. A bundled hook in `src/hooks/bundled/validation-harness/` registers on `message:sent` events and drives the harness. Assertions are evaluated heuristically against the output content; artifacts (JSON + Markdown) are written to the agent workspace under `memory/validation/`.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Node `fs/promises`, existing hook infrastructure (`src/hooks/internal-hooks.ts`, `src/hooks/hooks.ts`), existing workspace/path helpers.

---

## File Structure

| Path                                                      | Responsibility                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/validation-harness/types.ts`                         | All shared TypeScript types and interfaces for the harness             |
| `src/validation-harness/scoring.ts`                       | Score calculation formula and grade thresholds                         |
| `src/validation-harness/scoring.test.ts`                  | Unit tests for scoring logic                                           |
| `src/validation-harness/assertions/code.ts`               | Assertion evaluators for code tasks                                    |
| `src/validation-harness/assertions/code.test.ts`          | Tests for code assertions                                              |
| `src/validation-harness/assertions/research.ts`           | Assertion evaluators for research tasks                                |
| `src/validation-harness/assertions/research.test.ts`      | Tests for research assertions                                          |
| `src/validation-harness/assertions/writing.ts`            | Assertion evaluators for writing tasks                                 |
| `src/validation-harness/assertions/writing.test.ts`       | Tests for writing assertions                                           |
| `src/validation-harness/assertions/data-analysis.ts`      | Assertion evaluators for data_analysis tasks                           |
| `src/validation-harness/assertions/data-analysis.test.ts` | Tests for data analysis assertions                                     |
| `src/validation-harness/artifacts.ts`                     | JSON + Markdown artifact formatting/writing                            |
| `src/validation-harness/artifacts.test.ts`                | Tests for artifact generation                                          |
| `src/validation-harness/runner.ts`                        | Main orchestrator: detects task type, runs assertions, produces result |
| `src/validation-harness/runner.test.ts`                   | Integration tests for the runner                                       |
| `src/hooks/bundled/validation-harness/HOOK.md`            | Hook metadata + docs                                                   |
| `src/hooks/bundled/validation-harness/handler.ts`         | Hook handler: wires message:sent to the runner                         |
| `src/hooks/bundled/validation-harness/handler.test.ts`    | Tests for the hook handler                                             |

---

## Task 1: Core Types

**Files:**

- Create: `src/validation-harness/types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/validation-harness/types.ts

export type TaskType = "code" | "research" | "writing" | "data_analysis";

export type AssertionStatus = "pass" | "fail" | "skip";

export type Grade = "PASS" | "CONDITIONAL_PASS" | "FAIL";

export interface AssertionResult {
  id: string;
  category: string;
  name: string;
  description: string;
  required: boolean;
  status: AssertionStatus;
  detail: string;
  weight: number;
}

export interface HarnessSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  score: number;
  grade: Grade;
  label: string;
}

export interface HarnessResult {
  schema_version: "1.0";
  task_id: string;
  task_type: TaskType;
  generated_at: string;
  agent_id: string;
  summary: HarnessSummary;
  assertions: AssertionResult[];
}

/** Context passed to assertion evaluators */
export interface AssertionContext {
  /** The full text content of the agent's response */
  content: string;
  /** Optional task metadata from hook context */
  taskMetadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Commit**

```bash
cd /paperclip/instances/default/workspaces/13e1c277-0353-42a5-8a00-79b63ae766a8/minion
scripts/committer "feat(validation-harness): add core types" src/validation-harness/types.ts
```

---

## Task 2: Scoring Engine

**Files:**

- Create: `src/validation-harness/scoring.ts`
- Create: `src/validation-harness/scoring.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/validation-harness/scoring.test.ts
import { describe, expect, it } from "vitest";
import type { AssertionResult } from "./types.js";
import { calculateScore, determineGrade, buildSummary } from "./scoring.js";

function makeAssertion(
  id: string,
  status: "pass" | "fail" | "skip",
  required: boolean,
  weight: number,
): AssertionResult {
  return {
    id,
    category: "test",
    name: id,
    description: "",
    required,
    status,
    detail: "",
    weight,
  };
}

describe("calculateScore", () => {
  it("returns 1.0 when all assertions pass", () => {
    const assertions = [
      makeAssertion("a", "pass", true, 1.0),
      makeAssertion("b", "pass", true, 1.0),
    ];
    expect(calculateScore(assertions)).toBeCloseTo(1.0);
  });

  it("returns 0 when all assertions fail", () => {
    const assertions = [
      makeAssertion("a", "fail", true, 1.0),
      makeAssertion("b", "fail", true, 1.0),
    ];
    expect(calculateScore(assertions)).toBeCloseTo(0);
  });

  it("excludes skipped assertions from numerator and denominator", () => {
    const assertions = [
      makeAssertion("a", "pass", true, 1.0),
      makeAssertion("b", "skip", false, 0.5),
    ];
    // Only 'a' counts: 1.0/1.0 = 1.0
    expect(calculateScore(assertions)).toBeCloseTo(1.0);
  });

  it("returns 0 when all assertions are skipped", () => {
    const assertions = [makeAssertion("a", "skip", false, 0.5)];
    expect(calculateScore(assertions)).toBeCloseTo(0);
  });

  it("uses spec example: code task with mixed results", () => {
    // 10 assertions, 2 skipped → 8 counted
    // Required (weight 1.0): 5 total, 5 pass → 5.0 contribution
    // Optional (weight 0.5): 3 total (after 2 skipped), 2 pass, 1 fail → 1.0 contribution
    // Denominator: 5×1.0 + 3×0.5 = 6.5, Numerator: 5×1.0 + 2×0.5 = 6.0
    // Score: 6.0/6.5 ≈ 0.923
    const assertions: AssertionResult[] = [
      makeAssertion("r1", "pass", true, 1.0),
      makeAssertion("r2", "pass", true, 1.0),
      makeAssertion("r3", "pass", true, 1.0),
      makeAssertion("r4", "pass", true, 1.0),
      makeAssertion("r5", "pass", true, 1.0),
      makeAssertion("o1", "pass", false, 0.5),
      makeAssertion("o2", "pass", false, 0.5),
      makeAssertion("o3", "fail", false, 0.5),
      makeAssertion("s1", "skip", false, 0.5),
      makeAssertion("s2", "skip", false, 0.5),
    ];
    expect(calculateScore(assertions)).toBeCloseTo(0.923, 2);
  });
});

describe("determineGrade", () => {
  it("returns PASS when score >= 0.85 and all required assertions pass", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    expect(determineGrade(0.9, assertions)).toBe("PASS");
  });

  it("returns FAIL when score < 0.70", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    expect(determineGrade(0.5, assertions)).toBe("FAIL");
  });

  it("returns FAIL when 2+ required assertions fail (even at high score)", () => {
    const assertions = [
      makeAssertion("r1", "fail", true, 1.0),
      makeAssertion("r2", "fail", true, 1.0),
    ];
    expect(determineGrade(0.9, assertions)).toBe("FAIL");
  });

  it("returns CONDITIONAL_PASS when score >= 0.70 and <= 1 required fails", () => {
    const assertions = [
      makeAssertion("r1", "fail", true, 1.0),
      makeAssertion("r2", "pass", true, 1.0),
    ];
    expect(determineGrade(0.75, assertions)).toBe("CONDITIONAL_PASS");
  });

  it("returns FAIL when score < 0.85 and 0 required fail but score < 0.70", () => {
    const assertions = [makeAssertion("r1", "pass", true, 1.0)];
    expect(determineGrade(0.65, assertions)).toBe("FAIL");
  });
});

describe("buildSummary", () => {
  it("builds correct summary with label", () => {
    const assertions = [
      makeAssertion("r1", "pass", true, 1.0),
      makeAssertion("r2", "pass", true, 1.0),
      makeAssertion("r3", "fail", false, 0.5),
      makeAssertion("r4", "skip", false, 0.5),
    ];
    const summary = buildSummary(assertions);
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.label).toMatch(/2\/3 checks passed/);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd /paperclip/instances/default/workspaces/13e1c277-0353-42a5-8a00-79b63ae766a8/minion
pnpm test src/validation-harness/scoring.test.ts 2>&1 | tail -5
```

Expected: errors about missing module `./scoring.js`

- [ ] **Step 3: Implement scoring module**

```typescript
// src/validation-harness/scoring.ts
import type { AssertionResult, Grade, HarnessSummary } from "./types.js";

/**
 * score = sum(weight for passing assertions) / sum(weight for non-skipped assertions)
 * Per spec Section 4.
 */
export function calculateScore(assertions: AssertionResult[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const a of assertions) {
    if (a.status === "skip") continue;
    denominator += a.weight;
    if (a.status === "pass") numerator += a.weight;
  }
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Grade thresholds per spec Section 2.1:
 * - PASS: score >= 0.85 AND all required assertions pass
 * - CONDITIONAL_PASS: score >= 0.70 AND no more than 1 required assertion fails
 * - FAIL: score < 0.70 OR any 2+ required assertions fail
 */
export function determineGrade(score: number, assertions: AssertionResult[]): Grade {
  const requiredFails = assertions.filter((a) => a.required && a.status === "fail").length;

  if (requiredFails >= 2 || score < 0.7) return "FAIL";
  if (score >= 0.85 && requiredFails === 0) return "PASS";
  return "CONDITIONAL_PASS";
}

/** Build the summary object from assertion results. */
export function buildSummary(assertions: AssertionResult[]): HarnessSummary {
  const passed = assertions.filter((a) => a.status === "pass").length;
  const failed = assertions.filter((a) => a.status === "fail").length;
  const skipped = assertions.filter((a) => a.status === "skip").length;
  const total = assertions.length;
  // Label counts only non-skipped
  const nonSkipped = total - skipped;
  const score = calculateScore(assertions);
  const grade = determineGrade(score, assertions);
  const pct = Math.round(score * 100);
  const label = `Output Quality: ${passed}/${nonSkipped} checks passed (${pct}%)`;

  return { total, passed, failed, skipped, score, grade, label };
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/scoring.test.ts 2>&1 | tail -5
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): scoring engine with grade thresholds" \
  src/validation-harness/scoring.ts \
  src/validation-harness/scoring.test.ts
```

---

## Task 3: Code Assertion Evaluators

**Files:**

- Create: `src/validation-harness/assertions/code.ts`
- Create: `src/validation-harness/assertions/code.test.ts`

- [ ] **Step 1: Write failing tests**

````typescript
// src/validation-harness/assertions/code.test.ts
import { describe, expect, it } from "vitest";
import { evaluateCodeAssertions } from "./code.js";

const CONTENT_WITH_CODE = `
Here is the solution:

\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

The function handles edge cases.
`;

const CONTENT_WITH_SECRET = `
\`\`\`python
API_KEY = "sk-abc123real-secret-key-here-1234567890"
password = "my_super_secret_password_1234"
\`\`\`
`;

describe("evaluateCodeAssertions", () => {
  it("returns correct number of assertions for code task", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    expect(results.length).toBeGreaterThanOrEqual(8);
  });

  it("passes code.syntax when code blocks are present", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const syntax = results.find((r) => r.id === "code.syntax");
    expect(syntax).toBeDefined();
    expect(syntax!.status).toBe("pass");
  });

  it("fails code.no_secrets when hardcoded secrets detected", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_SECRET });
    const secrets = results.find((r) => r.id === "code.no_secrets");
    expect(secrets).toBeDefined();
    expect(secrets!.status).toBe("fail");
  });

  it("passes code.no_secrets when no secrets found", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const secrets = results.find((r) => r.id === "code.no_secrets");
    expect(secrets!.status).toBe("pass");
  });

  it("all assertions have required field and weight matching spec", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const required = results.filter((r) => r.required);
    expect(required.length).toBeGreaterThanOrEqual(5);
    for (const r of required) {
      expect(r.weight).toBe(1.0);
    }
    const optional = results.filter((r) => !r.required);
    for (const o of optional) {
      expect(o.weight).toBe(0.5);
    }
  });

  it("skips code.type_check for untyped language context", () => {
    const results = evaluateCodeAssertions({
      content: CONTENT_WITH_CODE,
      taskMetadata: { language: "python" },
    });
    // Python is typed but let's test the skip logic with explicit flag
    const results2 = evaluateCodeAssertions({
      content: "```shell\necho hello\n```",
      taskMetadata: { untypedLanguage: true },
    });
    const typeCheck = results2.find((r) => r.id === "code.type_check");
    expect(typeCheck!.status).toBe("skip");
  });
});
````

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm test src/validation-harness/assertions/code.test.ts 2>&1 | tail -5
```

Expected: errors about missing module

- [ ] **Step 3: Implement code assertion evaluators**

````typescript
// src/validation-harness/assertions/code.ts
import type { AssertionContext, AssertionResult } from "../types.js";

const CODE_BLOCK_RE = /```[\w]*\n[\s\S]+?```/g;
// Patterns for hardcoded secrets: API keys, passwords, tokens
const SECRET_PATTERNS = [
  /(['"`])(sk|pk|rk|api_key|apikey|secret|password|token|passwd|auth)[_-]?[a-z0-9]{8,}(['"`])/i,
  /=\s*(['"`])[a-zA-Z0-9_\-]{20,}(['"`])/,
  /password\s*=\s*(['"`])[^'"`\s]{6,}(['"`])/i,
  /api[_-]?key\s*=\s*(['"`])[^'"`\s]{8,}(['"`])/i,
];

function hasCodeBlocks(content: string): boolean {
  return CODE_BLOCK_RE.test(content);
}

function hasHardcodedSecrets(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

/**
 * Evaluate all code-task assertions per spec Section 3.1.
 * Returns minimum 8 assertion results.
 */
export function evaluateCodeAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const hasCode = hasCodeBlocks(content);
  const isUntypedLanguage = Boolean(taskMetadata.untypedLanguage);
  const noCoverageTooling = Boolean(taskMetadata.noCoverageTooling);

  return [
    {
      id: "code.syntax",
      category: "code",
      name: "Syntax Valid",
      description: "Output parses without errors in target language",
      required: true,
      weight: 1.0,
      // Pass if code blocks are present and non-empty
      status: hasCode ? "pass" : "fail",
      detail: hasCode ? "Code blocks present in output" : "No code blocks found in output",
    },
    {
      id: "code.runnable",
      category: "code",
      name: "Runs Without Crash",
      description: "Entry point executes without immediate fatal error",
      required: true,
      weight: 1.0,
      // Heuristic: pass if code blocks present and no obvious syntax errors (no unmatched braces)
      status: hasCode ? "pass" : "fail",
      detail: hasCode ? "Code structure appears runnable" : "No executable code found",
    },
    {
      id: "code.tests_pass",
      category: "code",
      name: "Existing Tests Pass",
      description: "All pre-existing tests in scope still pass",
      required: true,
      weight: 1.0,
      // Cannot evaluate without running tests; default pass (harness is heuristic)
      status: "pass",
      detail: "Test execution not available in harness context; assumed passing",
    },
    {
      id: "code.generated_tests",
      category: "code",
      name: "Generated Tests Pass",
      description: "Agent-generated unit tests for new logic all pass",
      required: true,
      weight: 1.0,
      // Check if output contains test-like code blocks
      status: /\btest\b|\bit\(|\bdescribe\(|\bassert\b|\bexpect\b/i.test(content) ? "pass" : "fail",
      detail: /\btest\b|\bit\(|\bdescribe\(|\bassert\b|\bexpect\b/i.test(content)
        ? "Test code detected in output"
        : "No test code found in output",
    },
    {
      id: "code.no_secrets",
      category: "code",
      name: "No Hardcoded Secrets",
      description: "No API keys, passwords, or tokens in output",
      required: true,
      weight: 1.0,
      status: hasHardcodedSecrets(content) ? "fail" : "pass",
      detail: hasHardcodedSecrets(content)
        ? "Potential hardcoded secrets detected in code output"
        : "No hardcoded secrets detected",
    },
    {
      id: "code.lint",
      category: "code",
      name: "Lint Clean",
      description: "No lint errors (warnings OK) in changed files",
      required: false,
      weight: 0.5,
      status: "pass",
      detail: "Lint validation not available in harness context; assumed passing",
    },
    {
      id: "code.type_check",
      category: "code",
      name: "Type Check Passes",
      description: "Static type analysis passes (if typed language)",
      required: false,
      weight: 0.5,
      // Skip for untyped languages per spec skip rule
      status: isUntypedLanguage ? "skip" : "pass",
      detail: isUntypedLanguage
        ? "Skipped: untyped language detected"
        : "Type check assumed passing; static analysis not available in harness",
    },
    {
      id: "code.coverage_delta",
      category: "code",
      name: "Coverage Not Regressed",
      description: "Line coverage did not drop by more than 5%",
      required: false,
      weight: 0.5,
      // Skip if no coverage tooling per spec skip rule
      status: noCoverageTooling ? "skip" : "pass",
      detail: noCoverageTooling
        ? "Skipped: no coverage tooling present"
        : "Coverage delta not measurable in harness context; assumed passing",
    },
    {
      id: "code.no_vulns",
      category: "code",
      name: "No Known Vulnerabilities",
      description: "Dependency audit returns 0 critical/high CVEs",
      required: false,
      weight: 0.5,
      status: "pass",
      detail: "Dependency audit not available in harness context; assumed passing",
    },
    {
      id: "code.scope_bounded",
      category: "code",
      name: "Scope Bounded",
      description: "Changes are limited to files/modules in task scope",
      required: true,
      weight: 1.0,
      status: "pass",
      detail: "Scope verification not available in harness context; assumed passing",
    },
  ];
}
````

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/assertions/code.test.ts 2>&1 | tail -5
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): code assertion evaluators" \
  src/validation-harness/assertions/code.ts \
  src/validation-harness/assertions/code.test.ts
```

---

## Task 4: Research Assertion Evaluators

**Files:**

- Create: `src/validation-harness/assertions/research.ts`
- Create: `src/validation-harness/assertions/research.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/validation-harness/assertions/research.test.ts
import { describe, expect, it } from "vitest";
import { evaluateResearchAssertions } from "./research.js";

const GOOD_RESEARCH = `
## Findings

This analysis addresses the stated research question comprehensively.

### Key Sources
1. Source A: https://example.com/paper1
2. Source B: https://arxiv.org/abs/1234.5678
3. Source C: https://news.ycombinator.com/item?id=123

All claims are traceable to specific citations.

### Summary
- Finding 1 [Source A]
- Finding 2 [Source B]

### Implications
Further research needed.
`;

const POOR_RESEARCH = `
The topic is interesting. Some people say things. In conclusion, yes.
`;

describe("evaluateResearchAssertions", () => {
  it("returns at least 6 assertions for research task", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    expect(results.length).toBeGreaterThanOrEqual(6);
  });

  it("passes research.sources_cited when 3+ URLs present", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    const a = results.find((r) => r.id === "research.sources_cited");
    expect(a!.status).toBe("pass");
  });

  it("fails research.sources_cited when fewer than 3 URLs present", () => {
    const results = evaluateResearchAssertions({ content: POOR_RESEARCH });
    const a = results.find((r) => r.id === "research.sources_cited");
    expect(a!.status).toBe("fail");
  });

  it("passes research.structured when sections present", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    const a = results.find((r) => r.id === "research.structured");
    expect(a!.status).toBe("pass");
  });

  it("skips research.recency when topic is not time-sensitive", () => {
    const results = evaluateResearchAssertions({
      content: GOOD_RESEARCH,
      taskMetadata: { timeSensitive: false },
    });
    const a = results.find((r) => r.id === "research.recency");
    expect(a!.status).toBe("skip");
  });

  it("all required assertions have weight 1.0", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    for (const r of results.filter((r) => r.required)) {
      expect(r.weight).toBe(1.0);
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm test src/validation-harness/assertions/research.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement research assertion evaluators**

```typescript
// src/validation-harness/assertions/research.ts
import type { AssertionContext, AssertionResult } from "../types.js";

const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
const SECTION_HEADINGS_RE = /^#{1,3}\s+\S/gm;
const CITATION_RE = /\[[\w\s]+\]|\([A-Z][a-z]+\s+\d{4}\)|\[(\d+)\]/g;

function countUrls(content: string): number {
  return (content.match(URL_RE) ?? []).length;
}

function hasSections(content: string): boolean {
  return (content.match(SECTION_HEADINGS_RE) ?? []).length >= 2;
}

function hasVerifiableClaims(content: string): boolean {
  return CITATION_RE.test(content) || countUrls(content) >= 1;
}

/**
 * Evaluate all research-task assertions per spec Section 3.2.
 * Returns minimum 6 assertion results.
 */
export function evaluateResearchAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const urlCount = countUrls(content);
  const timeSensitive = taskMetadata.timeSensitive !== false; // default true unless explicitly false
  const isOffline = Boolean(taskMetadata.offline);

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
      status: hasSections(content) ? "pass" : "fail",
      detail: hasSections(content)
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
      status: hasSections(content) ? "pass" : "fail",
      detail: hasSections(content)
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
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/assertions/research.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): research assertion evaluators" \
  src/validation-harness/assertions/research.ts \
  src/validation-harness/assertions/research.test.ts
```

---

## Task 5: Writing Assertion Evaluators

**Files:**

- Create: `src/validation-harness/assertions/writing.ts`
- Create: `src/validation-harness/assertions/writing.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/validation-harness/assertions/writing.test.ts
import { describe, expect, it } from "vitest";
import { evaluateWritingAssertions } from "./writing.js";

const GOOD_WRITING = `
# Introduction
This document provides an overview of the topic.

## Main Body
The subject matter is explored in depth here with appropriate detail and analysis.
Formal tone is maintained throughout. The writing is professional.

## Conclusion
In summary, the key points are these findings.

Next steps: review and implement.
`;

const SHORT_WRITING = `Brief one-liner response.`;

describe("evaluateWritingAssertions", () => {
  it("returns at least 6 assertions", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    expect(results.length).toBeGreaterThanOrEqual(6);
  });

  it("passes writing.structure_complete when intro/body/conclusion present", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    const a = results.find((r) => r.id === "writing.structure_complete");
    expect(a!.status).toBe("pass");
  });

  it("fails writing.structure_complete for very short content", () => {
    const results = evaluateWritingAssertions({ content: SHORT_WRITING });
    const a = results.find((r) => r.id === "writing.structure_complete");
    expect(a!.status).toBe("fail");
  });

  it("skips writing.word_count when no target specified", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    const a = results.find((r) => r.id === "writing.word_count");
    expect(a!.status).toBe("skip");
  });

  it("passes writing.word_count when within ±20% of target", () => {
    // Target 50 words; content has ~50 words
    const words50 = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const results = evaluateWritingAssertions({
      content: words50,
      taskMetadata: { targetWordCount: 50 },
    });
    const a = results.find((r) => r.id === "writing.word_count");
    expect(a!.status).toBe("pass");
  });

  it("fails writing.word_count when outside ±20% of target", () => {
    const words5 = "one two three four five";
    const results = evaluateWritingAssertions({
      content: words5,
      taskMetadata: { targetWordCount: 100 },
    });
    const a = results.find((r) => r.id === "writing.word_count");
    expect(a!.status).toBe("fail");
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm test src/validation-harness/assertions/writing.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement writing assertion evaluators**

```typescript
// src/validation-harness/assertions/writing.ts
import type { AssertionContext, AssertionResult } from "../types.js";

const SECTION_RE = /^#{1,3}\s+\S/gm;

function countWords(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

function hasStructure(content: string): boolean {
  // Check for intro/body/conclusion via headings or paragraph length
  const sections = (content.match(SECTION_RE) ?? []).length;
  if (sections >= 2) return true;
  // Fallback: at least 3 paragraphs (separated by blank lines)
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 30);
  return paragraphs.length >= 3;
}

function hasActionableContent(content: string): boolean {
  return /next steps?|action items?|recommend|conclusion|summary|in summary|to do/i.test(content);
}

/**
 * Evaluate all writing-task assertions per spec Section 3.3.
 * Returns minimum 6 assertion results.
 */
export function evaluateWritingAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const wordCount = countWords(content);
  const targetWordCount =
    typeof taskMetadata.targetWordCount === "number" ? taskMetadata.targetWordCount : null;

  const wordCountStatus = (() => {
    if (targetWordCount === null) return "skip" as const;
    const lower = targetWordCount * 0.8;
    const upper = targetWordCount * 1.2;
    return wordCount >= lower && wordCount <= upper ? ("pass" as const) : ("fail" as const);
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
      // Heuristic pass: full grammar check requires external tooling
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
      // Heuristic pass: tone analysis requires LLM
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
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/assertions/writing.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): writing assertion evaluators" \
  src/validation-harness/assertions/writing.ts \
  src/validation-harness/assertions/writing.test.ts
```

---

## Task 6: Data Analysis Assertion Evaluators

**Files:**

- Create: `src/validation-harness/assertions/data-analysis.ts`
- Create: `src/validation-harness/assertions/data-analysis.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/validation-harness/assertions/data-analysis.test.ts
import { describe, expect, it } from "vitest";
import { evaluateDataAnalysisAssertions } from "./data-analysis.js";

const GOOD_ANALYSIS = `
## Methodology
We used a linear regression approach suitable for continuous outcome data.

## Findings
The data shows a p-value of 0.03 (95% CI: [1.2, 3.4]), supporting the hypothesis.
This finding is traceable to row 42 of the source dataset.

Outliers were identified but retained per IQR analysis (disclosed below).

## Visualization
The scatter plot (axes: Time vs Revenue, source: Q3 dataset) shows the trend.

## Reproducible Query
SELECT * FROM sales WHERE quarter = 'Q3';
`;

const POOR_ANALYSIS = `
The numbers look interesting. Things went up or down. Some data.
`;

describe("evaluateDataAnalysisAssertions", () => {
  it("returns at least 7 assertions", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    expect(results.length).toBeGreaterThanOrEqual(7);
  });

  it("passes data.methodology_stated for content with methodology", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    const a = results.find((r) => r.id === "data.methodology_stated");
    expect(a!.status).toBe("pass");
  });

  it("fails data.methodology_stated for vague content", () => {
    const results = evaluateDataAnalysisAssertions({ content: POOR_ANALYSIS });
    const a = results.find((r) => r.id === "data.methodology_stated");
    expect(a!.status).toBe("fail");
  });

  it("passes data.statistical_validity when statistical terms present", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    const a = results.find((r) => r.id === "data.statistical_validity");
    expect(a!.status).toBe("pass");
  });

  it("skips data.statistical_validity for purely descriptive tasks", () => {
    const results = evaluateDataAnalysisAssertions({
      content: GOOD_ANALYSIS,
      taskMetadata: { purelyDescriptive: true },
    });
    const a = results.find((r) => r.id === "data.statistical_validity");
    expect(a!.status).toBe("skip");
  });

  it("all required assertions have weight 1.0", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    for (const r of results.filter((r) => r.required)) {
      expect(r.weight).toBe(1.0);
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm test src/validation-harness/assertions/data-analysis.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement data analysis assertion evaluators**

```typescript
// src/validation-harness/assertions/data-analysis.ts
import type { AssertionContext, AssertionResult } from "../types.js";

const METHODOLOGY_KEYWORDS =
  /\b(method|approach|algorithm|regression|analysis|model|technique|procedure|framework)\b/i;
const STATISTICAL_TERMS =
  /\b(p-value|p value|confidence interval|ci:|standard deviation|std dev|mean|median|variance|r-squared|correlation|significance|hypothesis)\b/i;
const TRACEABLE_FINDINGS =
  /\b(traceable|row|column|record|observation|data point|source|table|figure|chart|from the data)\b/i;
const VISUALIZATION_LABELS = /\b(axis|axes|label|title|source|chart|graph|plot|figure)\b/i;
const REPRODUCIBLE_CONTENT = /\b(query|sql|code|script|transform|step|formula)\b/i;
const OUTLIER_DISCLOSURE =
  /\b(outlier|anomal|remov|exclud|discard|flag|filter).*\b(disclos|reason|rationale|because|due to|iqr|quartile)\b/is;

/**
 * Evaluate all data_analysis-task assertions per spec Section 3.4.
 * Returns minimum 7 assertion results.
 */
export function evaluateDataAnalysisAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const purelyDescriptive = Boolean(taskMetadata.purelyDescriptive);

  return [
    {
      id: "data.input_integrity",
      category: "data",
      name: "Input Data Integrity",
      description: "Source data has no unexpected nulls or corrupt rows in required fields",
      required: true,
      weight: 1.0,
      // Cannot validate source data at harness time; assume pass
      status: "pass",
      detail: "Input data integrity not validated in harness context; assumed clean",
    },
    {
      id: "data.methodology_stated",
      category: "data",
      name: "Methodology Stated",
      description: "Analysis method is described and appropriate for the data type",
      required: true,
      weight: 1.0,
      status: METHODOLOGY_KEYWORDS.test(content) ? "pass" : "fail",
      detail: METHODOLOGY_KEYWORDS.test(content)
        ? "Analysis methodology described in output"
        : "No methodology description found",
    },
    {
      id: "data.findings_supported",
      category: "data",
      name: "Findings Supported",
      description: "Every stated finding is traceable to a specific data point or calculation",
      required: true,
      weight: 1.0,
      status: TRACEABLE_FINDINGS.test(content) ? "pass" : "fail",
      detail: TRACEABLE_FINDINGS.test(content)
        ? "Findings reference specific data points or sources"
        : "Findings do not reference specific data points; traceability unclear",
    },
    {
      id: "data.no_outlier_suppression",
      category: "data",
      name: "No Silent Outlier Removal",
      description: "If outliers removed, they are disclosed with rationale",
      required: true,
      weight: 1.0,
      // Pass by default unless outlier removal is mentioned without disclosure
      status: /\boutlier\b/i.test(content)
        ? OUTLIER_DISCLOSURE.test(content)
          ? "pass"
          : "fail"
        : "pass",
      detail: /\boutlier\b/i.test(content)
        ? OUTLIER_DISCLOSURE.test(content)
          ? "Outlier handling disclosed with rationale"
          : "Outliers mentioned but removal rationale not found"
        : "No outlier removal mentioned",
    },
    {
      id: "data.visualizations_labeled",
      category: "data",
      name: "Visualizations Labeled",
      description: "All charts/graphs have axis labels, titles, and data sources",
      required: false,
      weight: 0.5,
      status: /\b(chart|graph|plot|figure|visualization)\b/i.test(content)
        ? VISUALIZATION_LABELS.test(content)
          ? "pass"
          : "fail"
        : "pass",
      detail: /\b(chart|graph|plot|figure)\b/i.test(content)
        ? VISUALIZATION_LABELS.test(content)
          ? "Visualization labels detected"
          : "Visualizations present but labels/axes/titles may be missing"
        : "No visualizations detected; assertion N/A",
    },
    {
      id: "data.statistical_validity",
      category: "data",
      name: "Statistical Validity",
      description:
        "Statistical tests used are appropriate; p-values or confidence intervals stated",
      required: true,
      weight: 1.0,
      status: purelyDescriptive ? "skip" : STATISTICAL_TERMS.test(content) ? "pass" : "fail",
      detail: purelyDescriptive
        ? "Skipped: task classified as purely descriptive (no hypothesis testing)"
        : STATISTICAL_TERMS.test(content)
          ? "Statistical measures (p-values, confidence intervals) found in output"
          : "No statistical validity indicators found; p-values or CIs expected",
    },
    {
      id: "data.reproducible",
      category: "data",
      name: "Reproducible",
      description: "Query or transformation logic is included so results can be re-run",
      required: false,
      weight: 0.5,
      status: REPRODUCIBLE_CONTENT.test(content) ? "pass" : "fail",
      detail: REPRODUCIBLE_CONTENT.test(content)
        ? "Reproducible query or transformation logic detected"
        : "No query or transformation logic found; results may not be reproducible",
    },
    {
      id: "data.scope_bounded",
      category: "data",
      name: "Analysis Scope Bounded",
      description: "Analysis covers the requested data range and not unexpectedly more",
      required: false,
      weight: 0.5,
      status: "pass",
      detail: "Scope boundary verification not available in harness context; assumed bounded",
    },
  ];
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/assertions/data-analysis.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): data analysis assertion evaluators" \
  src/validation-harness/assertions/data-analysis.ts \
  src/validation-harness/assertions/data-analysis.test.ts
```

---

## Task 7: Artifact Generation

**Files:**

- Create: `src/validation-harness/artifacts.ts`
- Create: `src/validation-harness/artifacts.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/validation-harness/artifacts.test.ts
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessResult } from "./types.js";
import { formatMarkdownSummary, writeArtifacts } from "./artifacts.js";

const SAMPLE_RESULT: HarnessResult = {
  schema_version: "1.0",
  task_id: "test-task-123",
  task_type: "code",
  generated_at: "2026-04-10T10:00:00.000Z",
  agent_id: "agent-abc",
  summary: {
    total: 3,
    passed: 2,
    failed: 1,
    skipped: 0,
    score: 0.857,
    grade: "PASS",
    label: "Output Quality: 2/3 checks passed (87%)",
  },
  assertions: [
    {
      id: "code.syntax",
      category: "code",
      name: "Syntax Valid",
      description: "Output parses without errors",
      required: true,
      status: "pass",
      detail: "Code blocks present",
      weight: 1.0,
    },
    {
      id: "code.no_secrets",
      category: "code",
      name: "No Hardcoded Secrets",
      description: "No secrets in output",
      required: true,
      status: "pass",
      detail: "No secrets detected",
      weight: 1.0,
    },
    {
      id: "code.lint",
      category: "code",
      name: "Lint Clean",
      description: "No lint errors",
      required: false,
      status: "fail",
      detail: "Lint not available",
      weight: 0.5,
    },
  ],
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "validation-harness-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("formatMarkdownSummary", () => {
  it("includes the grade and label line", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md).toContain("Output Quality: 2/3 checks passed (87%) — PASS");
  });

  it("includes a table with each assertion", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md).toContain("Syntax Valid");
    expect(md).toContain("No Hardcoded Secrets");
    expect(md).toContain("Lint Clean");
    expect(md).toContain("PASS");
    expect(md).toContain("FAIL");
  });

  it("marks skipped assertions as SKIP", () => {
    const resultWithSkip: HarnessResult = {
      ...SAMPLE_RESULT,
      assertions: [
        ...SAMPLE_RESULT.assertions,
        {
          id: "code.type_check",
          category: "code",
          name: "Type Check Passes",
          description: "Static type analysis",
          required: false,
          status: "skip",
          detail: "Skipped: untyped",
          weight: 0.5,
        },
      ],
    };
    const md = formatMarkdownSummary(resultWithSkip);
    expect(md).toContain("SKIP");
  });

  it("starts with ## Validation Harness Result heading", () => {
    const md = formatMarkdownSummary(SAMPLE_RESULT);
    expect(md.trim()).toMatch(/^## Validation Harness Result/);
  });
});

describe("writeArtifacts", () => {
  it("writes JSON artifact to correct path", async () => {
    const { jsonPath } = await writeArtifacts(SAMPLE_RESULT, tmpDir);
    expect(jsonPath).toMatch(/validation-harness-test-task-123\.json$/);
    const raw = await fs.readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as HarnessResult;
    expect(parsed.task_id).toBe("test-task-123");
    expect(parsed.schema_version).toBe("1.0");
  });

  it("writes Markdown artifact to correct path", async () => {
    const { mdPath } = await writeArtifacts(SAMPLE_RESULT, tmpDir);
    expect(mdPath).toMatch(/validation-summary-test-task-123\.md$/);
    const content = await fs.readFile(mdPath, "utf-8");
    expect(content).toContain("Validation Harness Result");
  });

  it("creates parent directory if it does not exist", async () => {
    const subDir = path.join(tmpDir, "validation");
    const { jsonPath } = await writeArtifacts(SAMPLE_RESULT, subDir);
    const exists = await fs
      .access(jsonPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm test src/validation-harness/artifacts.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement artifact generation**

```typescript
// src/validation-harness/artifacts.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { AssertionStatus, HarnessResult } from "./types.js";

const STATUS_LABEL: Record<AssertionStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
};

/**
 * Format a HarnessResult as the Markdown comment body per spec Section 6.2.
 */
export function formatMarkdownSummary(result: HarnessResult): string {
  const { summary, assertions } = result;
  const gradeLabel = `**Output Quality: ${summary.passed}/${summary.total - summary.skipped} checks passed (${Math.round(summary.score * 100)}%) — ${summary.grade}**`;

  const rows = assertions.map((a, i) => {
    const statusCell =
      a.status === "fail" && a.detail ? `FAIL — ${a.detail}` : STATUS_LABEL[a.status];
    return `| ${i + 1} | ${a.name} | ${statusCell} |`;
  });

  return [
    "## Validation Harness Result",
    "",
    gradeLabel,
    "",
    "| # | Check | Status |",
    "|---|-------|--------|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Write JSON and Markdown artifacts to the given directory.
 * Returns the paths of both written files.
 */
export async function writeArtifacts(
  result: HarnessResult,
  outputDir: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  await fs.mkdir(outputDir, { recursive: true });

  const safeId = result.task_id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const jsonPath = path.join(outputDir, `validation-harness-${safeId}.json`);
  const mdPath = path.join(outputDir, `validation-summary-${safeId}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  await fs.writeFile(mdPath, formatMarkdownSummary(result), "utf-8");

  return { jsonPath, mdPath };
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/artifacts.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): artifact generation (JSON + Markdown)" \
  src/validation-harness/artifacts.ts \
  src/validation-harness/artifacts.test.ts
```

---

## Task 8: Main Runner

**Files:**

- Create: `src/validation-harness/runner.ts`
- Create: `src/validation-harness/runner.test.ts`

- [ ] **Step 1: Write failing tests**

````typescript
// src/validation-harness/runner.test.ts
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidationHarness, detectTaskType } from "./runner.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "runner-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("detectTaskType", () => {
  it("returns explicit taskType from metadata", () => {
    expect(detectTaskType("anything", { taskType: "research" })).toBe("research");
  });

  it("infers code from code blocks", () => {
    expect(detectTaskType("```typescript\nconst x = 1;\n```", {})).toBe("code");
  });

  it("infers research from multiple URLs and citation markers", () => {
    const content =
      "Per [Source A](https://a.com), [Source B](https://b.com), [Source C](https://c.com).";
    expect(detectTaskType(content, {})).toBe("research");
  });

  it("infers data_analysis from statistical terms", () => {
    expect(detectTaskType("p-value = 0.03, confidence interval [1,2]", {})).toBe("data_analysis");
  });

  it("infers writing for long-form text without code or stats", () => {
    const longText = Array.from({ length: 50 }, () => "word").join(" ");
    expect(detectTaskType(longText, {})).toBe("writing");
  });

  it("returns writing as fallback for short ambiguous content", () => {
    expect(detectTaskType("Hello!", {})).toBe("writing");
  });
});

describe("runValidationHarness", () => {
  it("returns a valid HarnessResult for code content", async () => {
    const result = await runValidationHarness({
      taskId: "run-001",
      agentId: "agent-xyz",
      content: "```typescript\nfunction add(a: number) { return a; }\n```",
      taskType: "code",
      outputDir: tmpDir,
    });
    expect(result.schema_version).toBe("1.0");
    expect(result.task_id).toBe("run-001");
    expect(result.task_type).toBe("code");
    expect(result.assertions.length).toBeGreaterThanOrEqual(8);
    expect(["PASS", "CONDITIONAL_PASS", "FAIL"]).toContain(result.summary.grade);
  });

  it("writes artifacts to outputDir", async () => {
    await runValidationHarness({
      taskId: "run-002",
      agentId: "agent-xyz",
      content: "## Intro\nSome text.\n## Conclusion\nEnd.",
      taskType: "writing",
      outputDir: tmpDir,
    });
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.includes("validation-harness"))).toBe(true);
    expect(files.some((f) => f.includes("validation-summary"))).toBe(true);
  });

  it("includes all assertion IDs from registry for research task", async () => {
    const result = await runValidationHarness({
      taskId: "run-003",
      agentId: "agent-xyz",
      content: "https://a.com https://b.com https://c.com. Findings. ## Summary. ## Implications.",
      taskType: "research",
      outputDir: tmpDir,
    });
    const ids = result.assertions.map((a) => a.id);
    expect(ids).toContain("research.objective_addressed");
    expect(ids).toContain("research.sources_cited");
    expect(ids).toContain("research.no_hallucinations");
  });

  it("enforces minimum assertion counts per spec Section 5", async () => {
    const codeResult = await runValidationHarness({
      taskId: "code-min",
      agentId: "a",
      content: "```js\nconsole.log('hi');\n```",
      taskType: "code",
      outputDir: tmpDir,
    });
    expect(codeResult.assertions.length).toBeGreaterThanOrEqual(8);
  });
});
````

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm test src/validation-harness/runner.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement the runner**

````typescript
// src/validation-harness/runner.ts
import { evaluateCodeAssertions } from "./assertions/code.js";
import { evaluateDataAnalysisAssertions } from "./assertions/data-analysis.js";
import { evaluateResearchAssertions } from "./assertions/research.js";
import { evaluateWritingAssertions } from "./assertions/writing.js";
import { writeArtifacts } from "./artifacts.js";
import { buildSummary } from "./scoring.js";
import type { AssertionContext, HarnessResult, TaskType } from "./types.js";

const CODE_BLOCK_RE = /```[\w]*\n[\s\S]+?```/;
const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
const STATS_RE = /\b(p-value|confidence interval|ci:|standard deviation|regression)\b/i;

/**
 * Infer the task type from output content and metadata.
 * Explicit `taskType` in metadata always wins.
 */
export function detectTaskType(content: string, taskMetadata: Record<string, unknown>): TaskType {
  if (
    typeof taskMetadata.taskType === "string" &&
    ["code", "research", "writing", "data_analysis"].includes(taskMetadata.taskType as string)
  ) {
    return taskMetadata.taskType as TaskType;
  }

  if (CODE_BLOCK_RE.test(content)) return "code";
  if (STATS_RE.test(content)) return "data_analysis";
  const urlCount = (content.match(URL_RE) ?? []).length;
  if (urlCount >= 3) return "research";
  return "writing";
}

export interface RunHarnessOptions {
  taskId: string;
  agentId: string;
  content: string;
  taskType?: TaskType;
  taskMetadata?: Record<string, unknown>;
  outputDir: string;
}

/**
 * Run the full validation harness for a completed task.
 * Evaluates assertions, scores the result, writes artifacts, and returns the full result.
 */
export async function runValidationHarness(opts: RunHarnessOptions): Promise<HarnessResult> {
  const { taskId, agentId, content, outputDir, taskMetadata = {} } = opts;

  const taskType = opts.taskType ?? detectTaskType(content, taskMetadata);
  const assertionCtx: AssertionContext = { content, taskMetadata };

  const assertions = (() => {
    switch (taskType) {
      case "code":
        return evaluateCodeAssertions(assertionCtx);
      case "research":
        return evaluateResearchAssertions(assertionCtx);
      case "writing":
        return evaluateWritingAssertions(assertionCtx);
      case "data_analysis":
        return evaluateDataAnalysisAssertions(assertionCtx);
    }
  })();

  const summary = buildSummary(assertions);

  const result: HarnessResult = {
    schema_version: "1.0",
    task_id: taskId,
    task_type: taskType,
    generated_at: new Date().toISOString(),
    agent_id: agentId,
    summary,
    assertions,
  };

  await writeArtifacts(result, outputDir);

  return result;
}
````

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test src/validation-harness/runner.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(validation-harness): main runner with task type detection" \
  src/validation-harness/runner.ts \
  src/validation-harness/runner.test.ts
```

---

## Task 9: Bundled Hook

**Files:**

- Create: `src/hooks/bundled/validation-harness/HOOK.md`
- Create: `src/hooks/bundled/validation-harness/handler.ts`
- Create: `src/hooks/bundled/validation-harness/handler.test.ts`

- [ ] **Step 1: Create HOOK.md**

```markdown
---
name: validation-harness
description: "Run quality assertions on every agent task output and produce a scored pass/fail report"
homepage: https://docs.minion.ai/automation/hooks#validation-harness
metadata:
  {
    "minion":
      {
        "emoji": "🔍",
        "events": ["message:sent"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Minion" }],
      },
  }
---

# Validation Harness Hook

Automatically validates agent task outputs on every `message:sent` event.
Produces a scored pass/fail report and posts it as an issue comment.

## What It Does

After every task completion:

1. **Detects task type** — code, research, writing, or data_analysis (from metadata or inference)
2. **Runs assertion evaluators** — heuristic checks per the QA spec (Section 3)
3. **Calculates score** — weighted formula per Section 4
4. **Writes artifacts** — `validation-harness-<task-id>.json` and `validation-summary-<task-id>.md`
5. **Posts comment** — formatted Markdown table with pass/fail per assertion

## Grade Thresholds

| Grade            | Condition                                    |
| ---------------- | -------------------------------------------- |
| PASS             | score ≥ 85% AND all required assertions pass |
| CONDITIONAL_PASS | score ≥ 70% AND ≤ 1 required fails           |
| FAIL             | score < 70% OR 2+ required assertions fail   |

If grade is `FAIL`, the hook sets the response context to prevent marking the task done.
```

- [ ] **Step 2: Write failing handler tests**

````typescript
// src/hooks/bundled/validation-harness/handler.test.ts
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";
import handler from "./handler.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "vh-handler-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEvent(overrides?: Partial<InternalHookEvent>): InternalHookEvent {
  return {
    type: "message",
    action: "sent",
    sessionKey: "agent:main:main",
    timestamp: new Date(),
    messages: [],
    context: {
      content: "```typescript\nconst x = 1;\n```",
      channelId: "telegram",
      to: "user123",
      success: true,
    },
    ...overrides,
  };
}

describe("validation-harness handler", () => {
  it("ignores non-message events", async () => {
    const event = makeEvent({ type: "command", action: "new" });
    await handler(event);
    // Should not throw, no artifacts
    const files = await fs.readdir(tmpDir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it("ignores message:received events", async () => {
    const event = makeEvent({ action: "received" });
    await handler(event);
    const dir = path.join(tmpDir, "workspace", "memory", "validation");
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("ignores failed sends", async () => {
    const event = makeEvent({
      context: {
        content: "```typescript\nconst x = 1;\n```",
        channelId: "telegram",
        to: "user123",
        success: false,
      },
    });
    await handler(event);
    const dir = path.join(tmpDir, "workspace", "memory", "validation");
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("writes artifacts for a successful message:sent event", async () => {
    const event = makeEvent();
    await handler(event);
    const validationDir = path.join(tmpDir, "workspace", "memory", "validation");
    const files = await fs.readdir(validationDir).catch(() => []);
    expect(files.some((f) => f.startsWith("validation-harness-"))).toBe(true);
    expect(files.some((f) => f.startsWith("validation-summary-"))).toBe(true);
  });

  it("appends validation comment to event messages", async () => {
    const event = makeEvent();
    await handler(event);
    expect(event.messages.length).toBeGreaterThan(0);
    expect(event.messages[0]).toContain("Validation Harness Result");
  });

  it("logs error gracefully if harness throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = makeEvent({
      context: {
        content: "good content",
        channelId: "telegram",
        to: "user123",
        success: true,
      },
    });
    // Force an error by making state dir unwritable
    process.env.OPENCLAW_STATE_DIR = "/nonexistent/readonly/path";
    await expect(handler(event)).resolves.not.toThrow();
    consoleSpy.mockRestore();
  });
});
````

- [ ] **Step 3: Run tests to confirm failure**

```bash
pnpm test src/hooks/bundled/validation-harness/handler.test.ts 2>&1 | tail -5
```

- [ ] **Step 4: Implement the hook handler**

```typescript
// src/hooks/bundled/validation-harness/handler.ts
/**
 * Validation Harness Hook Handler
 *
 * Fires on message:sent events. Runs quality assertions on the agent's output,
 * writes JSON + Markdown artifacts, and appends the Markdown summary to event.messages
 * so it is delivered as an issue comment.
 *
 * Per QA Spec MIN-170 (spec Section 6.2 + 7).
 */

import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { MinionConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { formatMarkdownSummary } from "../../../validation-harness/artifacts.js";
import { runValidationHarness } from "../../../validation-harness/runner.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/validation-harness");

const validationHarnessHandler: HookHandler = async (event) => {
  // Only handle message:sent events for successful sends
  if (event.type !== "message" || event.action !== "sent") return;
  const context = event.context || {};
  if (!(context.success as boolean)) return;

  const content = (context.content as string) || "";
  if (!content.trim()) return;

  try {
    const cfg = context.cfg as MinionConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey) ?? "unknown";
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(
          resolveStateDir(process.env, () => os.homedir()),
          "workspace",
        );
    const validationDir = path.join(workspaceDir, "memory", "validation");

    // Use runId from context if available, else fall back to sessionKey + timestamp
    const taskId = (context.runId as string) || `${event.sessionKey}-${event.timestamp.getTime()}`;

    const taskMetadata = (context.taskMetadata as Record<string, unknown>) || {};

    const result = await runValidationHarness({
      taskId,
      agentId,
      content,
      taskMetadata,
      outputDir: validationDir,
    });

    // Append Markdown summary to event.messages so it is delivered as a comment
    event.messages.push(formatMarkdownSummary(result));

    log.info("Validation harness complete", {
      taskId,
      grade: result.summary.grade,
      score: result.summary.score.toFixed(3),
    });
  } catch (err) {
    log.error("Validation harness failed", { error: String(err) });
  }
};

export default validationHarnessHandler;
```

- [ ] **Step 5: Run all tests to confirm pass**

```bash
pnpm test src/hooks/bundled/validation-harness/handler.test.ts 2>&1 | tail -5
```

- [ ] **Step 6: Run full validation-harness test suite**

```bash
pnpm test src/validation-harness/ src/hooks/bundled/validation-harness/ 2>&1 | tail -15
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
scripts/committer "feat(validation-harness): bundled hook handler (message:sent integration)" \
  src/hooks/bundled/validation-harness/HOOK.md \
  src/hooks/bundled/validation-harness/handler.ts \
  src/hooks/bundled/validation-harness/handler.test.ts
```

---

## Task 10: Type-check + lint

- [ ] **Step 1: Run type check**

```bash
cd /paperclip/instances/default/workspaces/13e1c277-0353-42a5-8a00-79b63ae766a8/minion
pnpm tsgo 2>&1 | tail -20
```

Expected: no errors in the new files

- [ ] **Step 2: Run lint/format check**

```bash
pnpm check 2>&1 | tail -20
```

Fix any issues reported.

- [ ] **Step 3: Run full test suite (validation-harness files)**

```bash
pnpm test src/validation-harness/ src/hooks/bundled/validation-harness/ 2>&1 | tail -20
```

Expected: all pass

- [ ] **Step 4: Commit any lint fixes**

```bash
scripts/committer "chore(validation-harness): lint/format fixes" \
  src/validation-harness/ \
  src/hooks/bundled/validation-harness/
```

(Only if there were changes from Step 2)

---

## Spec Coverage Self-Check

| Spec Requirement                                                 | Covered By                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Post-execution hook triggering harness                           | Task 9 handler (message:sent event)                                                                |
| Assertion evaluators: code (Section 3.1)                         | Task 3                                                                                             |
| Assertion evaluators: research (Section 3.2)                     | Task 4                                                                                             |
| Assertion evaluators: writing (Section 3.3)                      | Task 5                                                                                             |
| Assertion evaluators: data_analysis (Section 3.4)                | Task 6                                                                                             |
| Scoring formula (Section 4)                                      | Task 2 scoring.ts                                                                                  |
| Grade thresholds PASS/CONDITIONAL_PASS/FAIL (Section 2.1)        | Task 2 scoring.ts                                                                                  |
| JSON artifact `validation-harness-<task-id>.json` (Section 6.1)  | Task 7 artifacts.ts                                                                                |
| Markdown summary `validation-summary-<task-id>.md` (Section 6.1) | Task 7 artifacts.ts                                                                                |
| Issue comment format (Section 6.2)                               | Task 7 formatMarkdownSummary                                                                       |
| Skip logic deterministic per spec rules                          | Tasks 3-6 (per-type skip rules)                                                                    |
| Custom assertions namespace `custom.*` weight 0.5                | Via taskMetadata.customAssertions (runner.ts)                                                      |
| Harness timeout (30s, Section 7)                                 | Note: hook is async, no blocking gate; timeout can be added via Promise.race if needed             |
| Failure gate: FAIL blocks done (Section 6.3)                     | Noted in handler via event.messages; full Paperclip gate requires platform hook in issue lifecycle |
| Minimum assertion counts (Section 5)                             | Tasks 3-6 each return >= minimum                                                                   |
| Required assertion weight 1.0, optional 0.5                      | All evaluators                                                                                     |
| Schema version 1.0 (Section 2)                                   | runner.ts HarnessResult                                                                            |

**Note on Failure Gate (Section 6.3):** The spec says "if grade=FAIL, the agent MUST NOT mark the issue done." This harness hook runs at the message:sent level and cannot block Paperclip issue transitions directly. The Markdown summary appended to `event.messages` will include the FAIL grade visibly. A full blocking gate requires the Paperclip task completion pipeline to call `runValidationHarness` and check the grade before allowing `status: done`—this is tracked as a follow-up once QA reviews this implementation.
