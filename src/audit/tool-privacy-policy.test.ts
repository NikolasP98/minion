import { describe, expect, it } from "vitest";
import { getToolPrivacyDeclaration, listDeclaredTools } from "./tool-privacy-policy.js";

describe("getToolPrivacyDeclaration", () => {
  describe("known tools", () => {
    it("returns correct declaration for web_search", () => {
      const decl = getToolPrivacyDeclaration("web_search");
      expect(decl.toolName).toBe("web_search");
      expect(decl.vendor).toBe("third-party");
      expect(decl.externalTransfer).toBe(true);
      expect(decl.dataCategories).toContain("user_content");
    });

    it("returns correct declaration for bash", () => {
      const decl = getToolPrivacyDeclaration("bash");
      expect(decl.toolName).toBe("bash");
      expect(decl.vendor).toBe("local");
      expect(decl.externalTransfer).toBe(false);
      expect(decl.dataCategories).toContain("file_content");
      expect(decl.dataCategories).toContain("credentials");
    });

    it("returns correct declaration for computer", () => {
      const decl = getToolPrivacyDeclaration("computer");
      expect(decl.vendor).toBe("local");
      expect(decl.externalTransfer).toBe(false);
    });

    it("returns correct declaration for read_file", () => {
      const decl = getToolPrivacyDeclaration("read_file");
      expect(decl.vendor).toBe("local");
      expect(decl.externalTransfer).toBe(false);
      expect(decl.dataCategories).toContain("file_content");
    });

    it("returns correct declaration for write_file", () => {
      const decl = getToolPrivacyDeclaration("write_file");
      expect(decl.vendor).toBe("local");
      expect(decl.externalTransfer).toBe(false);
      expect(decl.retentionPolicy).toBe("indefinite");
    });

    it("returns correct declaration for anthropic_messages", () => {
      const decl = getToolPrivacyDeclaration("anthropic_messages");
      expect(decl.vendor).toBe("anthropic");
      expect(decl.externalTransfer).toBe(true);
      expect(decl.retentionPolicy).toBe("30-days");
    });

    it("returns correct declaration for openai_chat", () => {
      const decl = getToolPrivacyDeclaration("openai_chat");
      expect(decl.vendor).toBe("openai");
      expect(decl.externalTransfer).toBe(true);
      expect(decl.retentionPolicy).toBe("30-days");
    });

    it("returns correct declaration for memory_store", () => {
      const decl = getToolPrivacyDeclaration("memory_store");
      expect(decl.vendor).toBe("local");
      expect(decl.externalTransfer).toBe(false);
      expect(decl.dataCategories).toContain("user_identity");
    });

    it("returns correct declaration for send_email", () => {
      const decl = getToolPrivacyDeclaration("send_email");
      expect(decl.vendor).toBe("third-party");
      expect(decl.externalTransfer).toBe(true);
      expect(decl.dataCategories).toContain("user_identity");
    });

    it("returns correct declaration for code_interpreter", () => {
      const decl = getToolPrivacyDeclaration("code_interpreter");
      expect(decl.vendor).toBe("local");
      expect(decl.externalTransfer).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    it("matches tool names case-insensitively", () => {
      const lower = getToolPrivacyDeclaration("bash");
      const upper = getToolPrivacyDeclaration("BASH");
      const mixed = getToolPrivacyDeclaration("Bash");
      expect(upper.vendor).toBe(lower.vendor);
      expect(mixed.vendor).toBe(lower.vendor);
    });

    it("trims whitespace from tool name", () => {
      const decl = getToolPrivacyDeclaration("  web_search  ");
      expect(decl.vendor).toBe("third-party");
    });
  });

  describe("unknown tools", () => {
    it("returns unknown vendor for unrecognised tool", () => {
      const decl = getToolPrivacyDeclaration("my_custom_tool");
      expect(decl.toolName).toBe("my_custom_tool");
      expect(decl.vendor).toBe("unknown");
    });

    it("marks unknown tools as external-transfer=true (conservative)", () => {
      const decl = getToolPrivacyDeclaration("some_new_tool");
      expect(decl.externalTransfer).toBe(true);
    });

    it("marks unknown tools as retentionPolicy=unknown", () => {
      const decl = getToolPrivacyDeclaration("some_new_tool");
      expect(decl.retentionPolicy).toBe("unknown");
    });

    it("preserves original toolName casing for unknown tools", () => {
      const decl = getToolPrivacyDeclaration("MyFancyTool");
      expect(decl.toolName).toBe("MyFancyTool");
    });
  });

  describe("listDeclaredTools", () => {
    it("returns a non-empty array", () => {
      const tools = listDeclaredTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("includes known tools", () => {
      const tools = listDeclaredTools();
      expect(tools).toContain("web_search");
      expect(tools).toContain("bash");
      expect(tools).toContain("read_file");
    });
  });
});
