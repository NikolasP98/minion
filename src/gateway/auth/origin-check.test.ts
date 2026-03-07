import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it("accepts same-origin host matches", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts loopback host mismatches for dev", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts allowlisted origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing origin", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects mismatched origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://attacker.example.com",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts wildcard port in allowedOrigins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "http://localhost:5173",
      allowedOrigins: ["http://localhost:*"],
    });
    expect(result.ok).toBe(true);
  });

  it("wildcard port matches any port number", () => {
    for (const port of ["3000", "4173", "5173", "8787"]) {
      const result = checkBrowserOrigin({
        requestHost: "gateway.example.com:18789",
        origin: `http://localhost:${port}`,
        allowedOrigins: ["http://localhost:*"],
      });
      expect(result.ok, `port ${port} should match`).toBe(true);
    }
  });

  it("wildcard port does not match non-numeric segments", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "http://localhost:abc",
      allowedOrigins: ["http://localhost:*"],
    });
    expect(result.ok).toBe(false);
  });
});
