import { describe, expect, it } from "vitest";
import { evaluateWritingAssertions } from "./writing.js";

const GOOD_WRITING = `
# Introduction
This document provides a thorough overview of the topic at hand.

## Main Body
The subject matter is explored in depth here with appropriate detail and analysis.
Formal tone is maintained throughout. The writing is professional and clear.

## Conclusion
In summary, the key findings support the following conclusions.

Next steps: review and implement the recommendations.
`;

const SHORT_WRITING = `Brief one-liner response.`;

describe("evaluateWritingAssertions", () => {
  it("returns 7 assertions (full registry)", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    expect(results.length).toBe(7);
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

  it("passes writing.actionable when next-step content present", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    const a = results.find((r) => r.id === "writing.actionable");
    expect(a!.status).toBe("pass");
  });

  it("fails writing.actionable when no actionable content", () => {
    const results = evaluateWritingAssertions({ content: SHORT_WRITING });
    const a = results.find((r) => r.id === "writing.actionable");
    expect(a!.status).toBe("fail");
  });

  it("all required assertions have weight 1.0", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    for (const r of results.filter((r) => r.required)) {
      expect(r.weight).toBe(1.0);
    }
  });

  it("all optional assertions have weight 0.5", () => {
    const results = evaluateWritingAssertions({ content: GOOD_WRITING });
    for (const o of results.filter((r) => !r.required)) {
      expect(o.weight).toBe(0.5);
    }
  });
});
