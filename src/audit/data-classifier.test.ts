import { describe, expect, it } from "vitest";
import { classifyParams } from "./data-classifier.js";

describe("classifyParams", () => {
  it("returns empty array for empty params", () => {
    expect(classifyParams({})).toEqual([]);
  });

  it("returns empty array for unrecognised field names", () => {
    expect(classifyParams({ foo: "bar", baz: 42 })).toEqual([]);
  });

  describe("user_content", () => {
    it("detects 'body'", () => {
      expect(classifyParams({ body: "hello" })).toContain("user_content");
    });

    it("detects 'text'", () => {
      expect(classifyParams({ text: "some text" })).toContain("user_content");
    });

    it("detects 'message'", () => {
      expect(classifyParams({ message: "hi" })).toContain("user_content");
    });

    it("detects 'content'", () => {
      expect(classifyParams({ content: "value" })).toContain("user_content");
    });

    it("detects 'query'", () => {
      expect(classifyParams({ query: "search term" })).toContain("user_content");
    });

    it("detects 'input'", () => {
      expect(classifyParams({ input: "value" })).toContain("user_content");
    });

    it("detects 'prompt'", () => {
      expect(classifyParams({ prompt: "do something" })).toContain("user_content");
    });
  });

  describe("user_identity", () => {
    it("detects 'email'", () => {
      expect(classifyParams({ email: "user@example.com" })).toContain("user_identity");
    });

    it("detects 'phone'", () => {
      expect(classifyParams({ phone: "+1234567890" })).toContain("user_identity");
    });

    it("detects 'name'", () => {
      expect(classifyParams({ name: "Alice" })).toContain("user_identity");
    });

    it("detects 'userId'", () => {
      expect(classifyParams({ userId: "u-123" })).toContain("user_identity");
    });

    it("detects 'user_id'", () => {
      expect(classifyParams({ user_id: "u-456" })).toContain("user_identity");
    });

    it("detects 'senderId'", () => {
      expect(classifyParams({ senderId: "s-789" })).toContain("user_identity");
    });

    it("detects 'username'", () => {
      expect(classifyParams({ username: "alice42" })).toContain("user_identity");
    });
  });

  describe("user_location", () => {
    it("detects 'lat'", () => {
      expect(classifyParams({ lat: 48.8566 })).toContain("user_location");
    });

    it("detects 'lng'", () => {
      expect(classifyParams({ lng: 2.3522 })).toContain("user_location");
    });

    it("detects 'location'", () => {
      expect(classifyParams({ location: "Paris" })).toContain("user_location");
    });

    it("detects 'address'", () => {
      expect(classifyParams({ address: "1 rue de Rivoli" })).toContain("user_location");
    });

    it("detects 'ip'", () => {
      expect(classifyParams({ ip: "203.0.113.1" })).toContain("user_location");
    });

    it("detects 'ip_addr'", () => {
      expect(classifyParams({ ip_addr: "203.0.113.1" })).toContain("user_location");
    });
  });

  describe("message_history", () => {
    it("detects 'history'", () => {
      expect(classifyParams({ history: [] })).toContain("message_history");
    });

    it("detects 'messages'", () => {
      expect(classifyParams({ messages: [] })).toContain("message_history");
    });

    it("detects 'context'", () => {
      expect(classifyParams({ context: "prior turns" })).toContain("message_history");
    });

    it("detects 'thread'", () => {
      expect(classifyParams({ thread: [] })).toContain("message_history");
    });

    it("detects 'conversation'", () => {
      expect(classifyParams({ conversation: [] })).toContain("message_history");
    });
  });

  describe("credentials", () => {
    it("detects 'token'", () => {
      expect(classifyParams({ token: "abc123" })).toContain("credentials");
    });

    it("detects 'key'", () => {
      expect(classifyParams({ key: "sk-xxx" })).toContain("credentials");
    });

    it("detects 'secret'", () => {
      expect(classifyParams({ secret: "s3cr3t" })).toContain("credentials");
    });

    it("detects 'password'", () => {
      expect(classifyParams({ password: "hunter2" })).toContain("credentials");
    });

    it("detects 'api_key'", () => {
      expect(classifyParams({ api_key: "sk-xxx" })).toContain("credentials");
    });

    it("detects 'auth_token'", () => {
      expect(classifyParams({ auth_token: "Bearer xxx" })).toContain("credentials");
    });
  });

  describe("file_content", () => {
    it("detects 'file'", () => {
      expect(classifyParams({ file: "data" })).toContain("file_content");
    });

    it("detects 'path'", () => {
      expect(classifyParams({ path: "/etc/passwd" })).toContain("file_content");
    });

    it("detects 'document'", () => {
      expect(classifyParams({ document: "text" })).toContain("file_content");
    });

    it("detects 'upload'", () => {
      expect(classifyParams({ upload: "data" })).toContain("file_content");
    });
  });

  describe("nested objects", () => {
    it("classifies nested fields", () => {
      const params = {
        user: {
          email: "alice@example.com",
          preferences: { theme: "dark" },
        },
      };
      const result = classifyParams(params);
      expect(result).toContain("user_identity");
    });

    it("classifies multiple categories from nested params", () => {
      const params = {
        query: "search",
        user: { userId: "u-1", location: "Paris" },
        auth: { token: "abc" },
      };
      const result = classifyParams(params);
      expect(result).toContain("credentials");
      expect(result).toContain("user_identity");
      expect(result).toContain("user_location");
      expect(result).toContain("user_content");
    });
  });

  describe("output order", () => {
    it("returns categories in FIELD_RULES order (credentials before user_content)", () => {
      const params = { token: "t", body: "b" };
      const result = classifyParams(params);
      const credIdx = result.indexOf("credentials");
      const contentIdx = result.indexOf("user_content");
      expect(credIdx).toBeGreaterThanOrEqual(0);
      expect(contentIdx).toBeGreaterThanOrEqual(0);
      expect(credIdx).toBeLessThan(contentIdx);
    });

    it("does not return duplicates", () => {
      const params = { token: "t1", api_key: "t2" };
      const result = classifyParams(params);
      const credCount = result.filter((c) => c === "credentials").length;
      expect(credCount).toBe(1);
    });
  });
});
