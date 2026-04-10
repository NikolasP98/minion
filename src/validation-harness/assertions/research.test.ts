import { describe, expect, it } from "vitest";
import { evaluateResearchAssertions } from "./research.js";

const GOOD_RESEARCH = `
## Findings

This analysis addresses the stated research question comprehensively.
The topic has been thoroughly explored from multiple angles.

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
  it("returns 7 assertions for research task (full registry)", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    expect(results.length).toBe(7);
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

  it("fails research.structured when no sections", () => {
    const results = evaluateResearchAssertions({ content: POOR_RESEARCH });
    const a = results.find((r) => r.id === "research.structured");
    expect(a!.status).toBe("fail");
  });

  it("skips research.recency when topic is not time-sensitive", () => {
    const results = evaluateResearchAssertions({
      content: GOOD_RESEARCH,
      taskMetadata: { timeSensitive: false },
    });
    const a = results.find((r) => r.id === "research.recency");
    expect(a!.status).toBe("skip");
  });

  it("includes research.recency as pass when time-sensitive (default)", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    const a = results.find((r) => r.id === "research.recency");
    expect(a!.status).toBe("pass");
  });

  it("skips research.sources_accessible when offline", () => {
    const results = evaluateResearchAssertions({
      content: GOOD_RESEARCH,
      taskMetadata: { offline: true },
    });
    const a = results.find((r) => r.id === "research.sources_accessible");
    expect(a!.status).toBe("skip");
  });

  it("all required assertions have weight 1.0", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    for (const r of results.filter((r) => r.required)) {
      expect(r.weight).toBe(1.0);
    }
  });

  it("all optional assertions have weight 0.5", () => {
    const results = evaluateResearchAssertions({ content: GOOD_RESEARCH });
    for (const o of results.filter((r) => !r.required)) {
      expect(o.weight).toBe(0.5);
    }
  });
});
