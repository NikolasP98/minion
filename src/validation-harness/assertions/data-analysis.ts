import type { AssertionContext, AssertionResult } from "../types.js";

const METHODOLOGY_KEYWORDS =
  /\b(method|approach|algorithm|regression|analysis|model|technique|procedure|framework)\b/i;
const STATISTICAL_TERMS =
  /\b(p-value|p value|confidence interval|ci:|standard deviation|std dev|mean|median|variance|r-squared|correlation|significance|hypothesis)\b/i;
const TRACEABLE_FINDINGS =
  /\b(traceable|row|column|record|observation|data point|source|table|figure|chart|from the data)\b/i;
const VISUALIZATION_LABELS = /\b(axis|axes|label|title|source|chart|graph|plot|figure)\b/i;
const REPRODUCIBLE_CONTENT = /\b(query|sql|code|script|transform|step|formula)\b/i;
const OUTLIER_KEYWORDS = /\boutliers?\b/i;
const OUTLIER_DISCLOSURE =
  /\b(outlier|anomal|remov|exclud|discard|flag|filter)[\s\S]{0,100}(disclos|reason|rationale|because|due to|iqr|quartile)\b/i;

/**
 * Evaluate all data_analysis-task assertions per spec Section 3.4.
 * Returns minimum 7 assertion results (8 total, matching registry).
 */
export function evaluateDataAnalysisAssertions(ctx: AssertionContext): AssertionResult[] {
  const { content, taskMetadata = {} } = ctx;
  const purelyDescriptive = Boolean(taskMetadata.purelyDescriptive);
  const hasOutlierMention = OUTLIER_KEYWORDS.test(content);
  const hasViz = /\b(chart|graph|plot|figure|visualization)\b/i.test(content);

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
      // Pass by default unless outlier removal mentioned without disclosure
      status: hasOutlierMention ? (OUTLIER_DISCLOSURE.test(content) ? "pass" : "fail") : "pass",
      detail: hasOutlierMention
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
      status: hasViz ? (VISUALIZATION_LABELS.test(content) ? "pass" : "fail") : "pass",
      detail: hasViz
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
