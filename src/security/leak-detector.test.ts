import { describe, expect, it } from "vitest";
import { hasCredentialPatterns, scanAndRedact } from "./leak-detector.js";

describe("leak-detector", () => {
  describe("scanAndRedact", () => {
    it("returns clean content unchanged", () => {
      const content = "Hello, this is a normal HTTP response with no secrets.";
      const result = scanAndRedact(content);
      expect(result.hasLeaks).toBe(false);
      expect(result.redacted).toBe(content);
      expect(result.count).toBe(0);
    });

    it("handles empty/null content", () => {
      expect(scanAndRedact("").hasLeaks).toBe(false);
    });

    describe("Anthropic keys", () => {
      it("redacts sk-ant- keys", () => {
        const content = "Authorization: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-ABCDEF";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:anthropic-api-key]");
        expect(result.redacted).not.toContain("sk-ant-");
      });
    });

    describe("OpenAI keys", () => {
      it("redacts sk- keys", () => {
        const content = '{"api_key": "sk-proj-1234567890abcdefghijklmnop"}';
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:");
        expect(result.redacted).not.toContain("sk-proj-");
      });
    });

    describe("GitHub tokens", () => {
      it("redacts ghp_ tokens", () => {
        const content = "token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:github-pat]");
      });

      it("redacts ghs_ tokens", () => {
        const content = "GITHUB_TOKEN=ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:github-secret]");
      });
    });

    describe("AWS keys", () => {
      it("redacts AKIA access keys", () => {
        const content = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:aws-access-key]");
      });
    });

    describe("Bearer tokens", () => {
      it("redacts long Bearer tokens", () => {
        const content =
          "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:bearer-token]");
      });
    });

    describe("Google keys", () => {
      it("redacts AIza keys", () => {
        const content = '{"key": "AIzaSyA1234567890-abcdefghijklmnopqrstuv"}';
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:google-api-key]");
      });
    });

    describe("Slack tokens", () => {
      it("redacts xoxb- tokens", () => {
        const content = "SLACK_TOKEN=xoxb-123456789012-abcdefghij";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:slack-token]");
      });
    });

    describe("Stripe keys", () => {
      it("redacts sk_test keys", () => {
        const content = "stripe_key: sk_test_1234567890abcdefghijklmnop";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:stripe-key]");
      });
    });

    describe("Private keys", () => {
      it("detects PEM private key headers", () => {
        const content = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:private-key]");
      });
    });

    describe("Connection strings", () => {
      it("redacts postgres connection strings", () => {
        const content = "DATABASE_URL=postgres://admin:supersecret@db.example.com:5432/mydb";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:connection-string]");
      });

      it("redacts mongodb connection strings", () => {
        const content = "MONGO_URI=mongodb://root:password123@mongo.example.com:27017/admin";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
      });
    });

    describe("Generic API key patterns", () => {
      it("redacts api_key=value", () => {
        const content = "api_key=sk1234567890abcdefghijklmnop";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.redacted).toContain("[REDACTED:");
      });

      it("redacts 'apiKey': 'value' in JSON", () => {
        const content = '{"apiKey": "abcdefghij1234567890klmnop"}';
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
      });
    });

    describe("multiple credentials", () => {
      it("redacts multiple credentials in one response", () => {
        const content = [
          "API_KEY=sk-proj-1234567890abcdefghijklmnop",
          "GITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
          "AWS_KEY=AKIAIOSFODNN7EXAMPLE",
        ].join("\n");
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(true);
        expect(result.count).toBeGreaterThanOrEqual(3);
        expect(result.matchedPatterns.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe("false positive resistance", () => {
      it("does NOT flag short strings", () => {
        const content = 'token: "abc123"';
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(false);
      });

      it("does NOT flag normal Bearer scheme without long token", () => {
        const content = "Authorization: Bearer short";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(false);
      });

      it("does NOT flag normal code that mentions 'key'", () => {
        const content = "const key = object.key; for (const key of keys) {}";
        const result = scanAndRedact(content);
        expect(result.hasLeaks).toBe(false);
      });
    });
  });

  describe("hasCredentialPatterns", () => {
    it("returns true for content with credentials", () => {
      expect(hasCredentialPatterns("key: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(true);
    });

    it("returns false for clean content", () => {
      expect(hasCredentialPatterns("Hello world")).toBe(false);
    });

    it("returns false for empty content", () => {
      expect(hasCredentialPatterns("")).toBe(false);
    });
  });

  describe("percent-encoding bypass prevention", () => {
    // Regression tests for: credentials percent-encoded to evade pattern matching.
    // e.g., `sk%2Dant%2D...` encodes `sk-ant-...` to bypass the anthropic-api-key regex.

    it("detects Anthropic key with percent-encoded dashes", () => {
      // sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      const encoded = "sk%2Dant%2Dapi03%2DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const result = scanAndRedact(encoded);
      expect(result.hasLeaks).toBe(true);
      expect(result.matchedPatterns).toContain("anthropic-api-key");
      expect(result.redacted).not.toContain("sk-ant-");
    });

    it("detects GitHub PAT with percent-encoded prefix", () => {
      // ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789
      const encoded = "ghp%5FAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
      const result = scanAndRedact(encoded);
      expect(result.hasLeaks).toBe(true);
      expect(result.matchedPatterns).toContain("github-pat");
    });

    it("detects connection string with percent-encoded credentials", () => {
      // postgres://user:p@ssword@host/db → password has @ encoded as %40
      const encoded = "postgres%3A%2F%2Fuser%3Ap%40ssword%40host%2Fdb";
      const result = scanAndRedact(encoded);
      expect(result.hasLeaks).toBe(true);
      expect(result.matchedPatterns).toContain("connection-string");
    });

    it("detects Bearer token in percent-encoded Authorization header value", () => {
      // Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDE
      const encoded = "Bearer%20AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDE";
      const result = scanAndRedact(encoded);
      expect(result.hasLeaks).toBe(true);
      expect(result.matchedPatterns).toContain("bearer-token");
    });

    it("still detects plain (non-encoded) credentials after this change", () => {
      const plain = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const result = scanAndRedact(plain);
      expect(result.hasLeaks).toBe(true);
      expect(result.matchedPatterns).toContain("anthropic-api-key");
    });

    it("handles invalid percent sequences gracefully", () => {
      // Incomplete percent encoding — should not throw
      const bad = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%2";
      expect(() => scanAndRedact(bad)).not.toThrow();
      const result = scanAndRedact(bad);
      expect(result.hasLeaks).toBe(true);
    });

    it("hasCredentialPatterns detects percent-encoded credentials", () => {
      const encoded = "sk%2Dant%2Dapi03%2DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      expect(hasCredentialPatterns(encoded)).toBe(true);
    });
  });
});
