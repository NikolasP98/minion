import { describe, expect, it } from "vitest";
import { categorizeEmail, summarizeCategories } from "./categorization.js";

describe("categorizeEmail", () => {
  it("classifies urgent subjects as urgent/high", () => {
    const result = categorizeEmail({ subject: "URGENT: server is down" });
    expect(result.category).toBe("urgent");
    expect(result.priority).toBe("high");
  });

  it("classifies newsletter senders as newsletter/low", () => {
    const result = categorizeEmail({ from: "updates@substack.com", subject: "Weekly digest" });
    expect(result.category).toBe("newsletter");
    expect(result.priority).toBe("low");
  });

  it("classifies promotional subjects", () => {
    const result = categorizeEmail({ subject: "50% off — sale ends tonight!" });
    expect(result.category).toBe("promotional");
    expect(result.priority).toBe("low");
  });

  it("classifies calendar invites", () => {
    const result = categorizeEmail({ subject: "Meeting invitation: Q2 planning" });
    expect(result.category).toBe("calendar_invite");
    expect(result.priority).toBe("high");
  });

  it("classifies financial emails", () => {
    const result = categorizeEmail({ subject: "Your invoice #1234 is ready" });
    expect(result.category).toBe("financial");
    expect(result.priority).toBe("medium");
  });

  it("classifies action-required emails", () => {
    const result = categorizeEmail({ subject: "Please review and approve the PR" });
    expect(result.category).toBe("action_required");
    expect(result.priority).toBe("high");
  });

  it("classifies social network notifications", () => {
    const result = categorizeEmail({ subject: "John liked your post" });
    expect(result.category).toBe("social");
    expect(result.priority).toBe("low");
  });

  it("classifies automated sender addresses", () => {
    const result = categorizeEmail({ from: "monitoring@company.com", subject: "Alert: disk 80%" });
    expect(result.category).toBe("automated");
    expect(result.priority).toBe("low");
  });

  it("defaults to personal for unmatched emails", () => {
    const result = categorizeEmail({ from: "friend@example.com", subject: "Hey, how are you?" });
    expect(result.category).toBe("personal");
  });

  it("includes a non-empty reasoning string", () => {
    const result = categorizeEmail({ subject: "URGENT: fix now!" });
    expect(result.reasoning).toBeTruthy();
  });

  it("includes a suggestedLabel string", () => {
    const result = categorizeEmail({ from: "noreply@example.com", subject: "Your order" });
    expect(result.suggestedLabel).toBeTruthy();
  });
});

describe("summarizeCategories", () => {
  it("produces a comma-separated count summary", () => {
    const results = [
      categorizeEmail({ subject: "URGENT fix" }),
      categorizeEmail({ subject: "Weekly digest" }),
      categorizeEmail({ from: "noreply@sub.com", subject: "News" }),
    ];
    const summary = summarizeCategories(results);
    expect(summary).toContain(":");
    expect(typeof summary).toBe("string");
  });

  it("returns empty string for empty input", () => {
    expect(summarizeCategories([])).toBe("");
  });
});
