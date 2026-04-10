import { describe, expect, it } from "vitest";
import { evaluateCodeAssertions } from "./code.js";

const CONTENT_WITH_CODE = `
Here is the solution:

\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}

describe("add", () => {
  it("sums two numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
});
\`\`\`

The function handles edge cases.
`;

const CONTENT_WITH_SECRET = `
\`\`\`python
API_KEY = "sk-abc123real-secret-key-here-1234567890"
password = "my_super_secret_password_1234"
\`\`\`
`;

const CONTENT_WITHOUT_CODE = `
This is a plain text response with no code blocks at all.
`;

describe("evaluateCodeAssertions", () => {
  it("returns 10 assertions for code task (full registry)", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    expect(results.length).toBe(10);
  });

  it("passes code.syntax when code blocks are present", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const syntax = results.find((r) => r.id === "code.syntax");
    expect(syntax).toBeDefined();
    expect(syntax!.status).toBe("pass");
  });

  it("fails code.syntax when no code blocks present", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITHOUT_CODE });
    const syntax = results.find((r) => r.id === "code.syntax");
    expect(syntax!.status).toBe("fail");
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

  it("passes code.generated_tests when test code detected", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const genTests = results.find((r) => r.id === "code.generated_tests");
    expect(genTests!.status).toBe("pass");
  });

  it("fails code.generated_tests when no test code", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITHOUT_CODE });
    const genTests = results.find((r) => r.id === "code.generated_tests");
    expect(genTests!.status).toBe("fail");
  });

  it("all required assertions have weight 1.0", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const required = results.filter((r) => r.required);
    expect(required.length).toBeGreaterThanOrEqual(5);
    for (const r of required) {
      expect(r.weight).toBe(1.0);
    }
  });

  it("all optional assertions have weight 0.5", () => {
    const results = evaluateCodeAssertions({ content: CONTENT_WITH_CODE });
    const optional = results.filter((r) => !r.required);
    for (const o of optional) {
      expect(o.weight).toBe(0.5);
    }
  });

  it("skips code.type_check for untyped language context", () => {
    const results = evaluateCodeAssertions({
      content: "```shell\necho hello\n```",
      taskMetadata: { untypedLanguage: true },
    });
    const typeCheck = results.find((r) => r.id === "code.type_check");
    expect(typeCheck!.status).toBe("skip");
  });

  it("skips code.coverage_delta when no coverage tooling", () => {
    const results = evaluateCodeAssertions({
      content: CONTENT_WITH_CODE,
      taskMetadata: { noCoverageTooling: true },
    });
    const coverage = results.find((r) => r.id === "code.coverage_delta");
    expect(coverage!.status).toBe("skip");
  });
});
