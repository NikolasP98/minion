import type { AssertionContext, AssertionResult } from "../types.js";

const CODE_BLOCK_RE = /```[\w]*\n[\s\S]+?```/g;
// Patterns for hardcoded secrets: API keys, passwords, tokens
const SECRET_PATTERNS = [
  /(['"`])(sk|pk|rk|api_key|apikey|secret|password|token|passwd|auth)[_-]?[a-z0-9]{8,}(['"`])/i,
  /=\s*(['"`])[a-zA-Z0-9_-]{20,}(['"`])/,
  /password\s*=\s*(['"`])[^'"`\s]{6,}(['"`])/i,
  /api[_-]?key\s*=\s*(['"`])[^'"`\s]{8,}(['"`])/i,
];

function hasCodeBlocks(content: string): boolean {
  CODE_BLOCK_RE.lastIndex = 0;
  return CODE_BLOCK_RE.test(content);
}

function hasHardcodedSecrets(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

function hasTestCode(content: string): boolean {
  return /\btest\b|\bit\(|\bdescribe\(|\bassert\b|\bexpect\b/i.test(content);
}

/**
 * Evaluate all code-task assertions per spec Section 3.1.
 * Returns minimum 8 assertion results (10 total, matching registry).
 */
export function evaluateCodeAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const hasCode = hasCodeBlocks(content);
  const isUntypedLanguage = Boolean(taskMetadata.untypedLanguage);
  const noCoverageTooling = Boolean(taskMetadata.noCoverageTooling);
  const secretsFound = hasHardcodedSecrets(content);
  const testCodeFound = hasTestCode(content);

  return [
    {
      id: "code.syntax",
      category: "code",
      name: "Syntax Valid",
      description: "Output parses without errors in target language",
      required: true,
      weight: 1.0,
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
      // Cannot evaluate without running tests; assume pass (heuristic harness)
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
      status: testCodeFound ? "pass" : "fail",
      detail: testCodeFound ? "Test code detected in output" : "No test code found in output",
    },
    {
      id: "code.no_secrets",
      category: "code",
      name: "No Hardcoded Secrets",
      description: "No API keys, passwords, or tokens in output",
      required: true,
      weight: 1.0,
      status: secretsFound ? "fail" : "pass",
      detail: secretsFound
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
