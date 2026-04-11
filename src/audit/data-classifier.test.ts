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

  describe("health_info", () => {
    it("detects 'diagnosis'", () => {
      expect(classifyParams({ diagnosis: "Type 2 Diabetes" })).toContain("health_info");
    });

    it("detects 'medical'", () => {
      expect(classifyParams({ medical: "record" })).toContain("health_info");
    });

    it("detects 'prescription'", () => {
      expect(classifyParams({ prescription: "Metformin 500mg" })).toContain("health_info");
    });

    it("detects 'patient_id'", () => {
      expect(classifyParams({ patient_id: "P-12345" })).toContain("health_info");
    });

    it("detects 'mrn'", () => {
      expect(classifyParams({ mrn: "MRN-98765" })).toContain("health_info");
    });

    it("detects 'icd_code'", () => {
      expect(classifyParams({ icd_code: "E11.9" })).toContain("health_info");
    });

    it("detects 'insurance_id'", () => {
      expect(classifyParams({ insurance_id: "INS-456" })).toContain("health_info");
    });

    it("detects 'lab_result'", () => {
      expect(classifyParams({ lab_result: "A1C: 6.5%" })).toContain("health_info");
    });

    it("detects 'allergy'", () => {
      expect(classifyParams({ allergy: "penicillin" })).toContain("health_info");
    });
  });

  describe("financial_info", () => {
    it("detects 'credit_card'", () => {
      expect(classifyParams({ credit_card: "4111111111111111" })).toContain("financial_info");
    });

    it("detects 'ssn'", () => {
      expect(classifyParams({ ssn: "123-45-6789" })).toContain("financial_info");
    });

    it("detects 'iban'", () => {
      expect(classifyParams({ iban: "DE89370400440532013000" })).toContain("financial_info");
    });

    it("detects 'bank_account'", () => {
      expect(classifyParams({ bank_account: "1234567890" })).toContain("financial_info");
    });

    it("detects 'cvv'", () => {
      expect(classifyParams({ cvv: "123" })).toContain("financial_info");
    });

    it("detects 'routing_number'", () => {
      expect(classifyParams({ routing_number: "021000021" })).toContain("financial_info");
    });

    it("detects 'transaction'", () => {
      expect(classifyParams({ transaction: "TXN-789" })).toContain("financial_info");
    });

    it("detects 'payment'", () => {
      expect(classifyParams({ payment: "pending" })).toContain("financial_info");
    });

    it("detects 'tax_id'", () => {
      expect(classifyParams({ tax_id: "XX-1234567" })).toContain("financial_info");
    });

    it("detects 'account_number'", () => {
      expect(classifyParams({ account_number: "9876543210" })).toContain("financial_info");
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

    it("returns health_info before financial_info in FIELD_RULES order", () => {
      const params = { diagnosis: "flu", credit_card: "4111" };
      const result = classifyParams(params);
      const healthIdx = result.indexOf("health_info");
      const finIdx = result.indexOf("financial_info");
      expect(healthIdx).toBeGreaterThanOrEqual(0);
      expect(finIdx).toBeGreaterThanOrEqual(0);
      expect(healthIdx).toBeLessThan(finIdx);
    });

    it("does not return duplicates", () => {
      const params = { token: "t1", api_key: "t2" };
      const result = classifyParams(params);
      const credCount = result.filter((c) => c === "credentials").length;
      expect(credCount).toBe(1);
    });
  });
});
