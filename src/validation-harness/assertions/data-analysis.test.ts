import { describe, expect, it } from "vitest";
import { evaluateDataAnalysisAssertions } from "./data-analysis.js";

const GOOD_ANALYSIS = `
## Methodology
We used a linear regression approach suitable for continuous outcome data.

## Findings
The data shows a p-value of 0.03 (95% CI: [1.2, 3.4]), supporting the hypothesis.
This finding is traceable to row 42 of the source dataset.

Outliers were identified and disclosed: 3 points removed per IQR rationale.

## Visualization
The scatter plot (axes: Time vs Revenue, title: Quarterly Trends, source: Q3 dataset) shows the trend.

## Reproducible Query
SELECT * FROM sales WHERE quarter = 'Q3';
`;

const POOR_ANALYSIS = `
The numbers look interesting. Things went up or down. Some data.
`;

describe("evaluateDataAnalysisAssertions", () => {
  it("returns 8 assertions (full registry)", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    expect(results.length).toBe(8);
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

  it("passes data.no_outlier_suppression when outlier disclosure present", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    const a = results.find((r) => r.id === "data.no_outlier_suppression");
    expect(a!.status).toBe("pass");
  });

  it("passes data.no_outlier_suppression when no outliers mentioned", () => {
    const results = evaluateDataAnalysisAssertions({ content: POOR_ANALYSIS });
    const a = results.find((r) => r.id === "data.no_outlier_suppression");
    expect(a!.status).toBe("pass");
  });

  it("fails data.no_outlier_suppression when outliers mentioned without rationale", () => {
    const results = evaluateDataAnalysisAssertions({
      content: "We removed outliers from the dataset to improve results.",
    });
    const a = results.find((r) => r.id === "data.no_outlier_suppression");
    expect(a!.status).toBe("fail");
  });

  it("passes data.reproducible when query present", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    const a = results.find((r) => r.id === "data.reproducible");
    expect(a!.status).toBe("pass");
  });

  it("all required assertions have weight 1.0", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    for (const r of results.filter((r) => r.required)) {
      expect(r.weight).toBe(1.0);
    }
  });

  it("all optional assertions have weight 0.5", () => {
    const results = evaluateDataAnalysisAssertions({ content: GOOD_ANALYSIS });
    for (const o of results.filter((r) => !r.required)) {
      expect(o.weight).toBe(0.5);
    }
  });
});
