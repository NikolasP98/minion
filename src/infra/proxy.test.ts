import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseScutilProxyOutput, resolveProxyUrl } from "./proxy.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

// Reset call counts + implementations between every test.
beforeEach(() => {
  vi.resetAllMocks();
  // Default: scutil unavailable (non-zero exit), so tests that don't configure it get undefined.
  spawnSyncMock.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  });
});

// ---------------------------------------------------------------------------
// parseScutilProxyOutput
// ---------------------------------------------------------------------------

describe("parseScutilProxyOutput", () => {
  it("returns HTTPS proxy with port when HTTPSEnable=1", () => {
    const output = `
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 8080
  HTTPSProxy : proxy.example.com
}`;
    expect(parseScutilProxyOutput(output)).toBe("http://proxy.example.com:8080");
  });

  it("falls back to HTTP proxy when HTTPS not present", () => {
    const output = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : corp-proxy.internal
}`;
    expect(parseScutilProxyOutput(output)).toBe("http://corp-proxy.internal:3128");
  });

  it("returns proxy without port when port is absent", () => {
    const output = `
<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : proxy.example.com
}`;
    expect(parseScutilProxyOutput(output)).toBe("http://proxy.example.com");
  });

  it("returns undefined when HTTPSEnable=0", () => {
    const output = `
<dictionary> {
  HTTPSEnable : 0
  HTTPSPort : 8080
  HTTPSProxy : proxy.example.com
}`;
    expect(parseScutilProxyOutput(output)).toBeUndefined();
  });

  it("returns undefined when neither HTTPSProxy nor HTTPProxy is present", () => {
    const output = `
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  FTPEnable : 0
}`;
    expect(parseScutilProxyOutput(output)).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(parseScutilProxyOutput("")).toBeUndefined();
  });

  it("prefers HTTPSProxy over HTTPProxy when both are present", () => {
    const output = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : http-proxy.example.com
  HTTPSEnable : 1
  HTTPSPort : 8080
  HTTPSProxy : https-proxy.example.com
}`;
    expect(parseScutilProxyOutput(output)).toBe("http://https-proxy.example.com:8080");
  });
});

// ---------------------------------------------------------------------------
// resolveProxyUrl
// ---------------------------------------------------------------------------

describe("resolveProxyUrl", () => {
  const ENV_KEYS = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const;
  const savedEnv: Partial<Record<string, string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns config proxy when provided — takes priority over env", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8888";
    expect(resolveProxyUrl("http://config-proxy:1234")).toBe("http://config-proxy:1234");
  });

  it("trims whitespace from config proxy", () => {
    expect(resolveProxyUrl("  http://config-proxy:1234  ")).toBe("http://config-proxy:1234");
  });

  it("returns undefined for blank config proxy and no env vars", () => {
    expect(resolveProxyUrl("")).toBeUndefined();
    expect(resolveProxyUrl("   ")).toBeUndefined();
    expect(resolveProxyUrl(undefined)).toBeUndefined();
  });

  it("picks up HTTPS_PROXY env var", () => {
    process.env.HTTPS_PROXY = "http://https-env-proxy:8080";
    expect(resolveProxyUrl()).toBe("http://https-env-proxy:8080");
  });

  it("picks up lowercase https_proxy env var", () => {
    process.env.https_proxy = "http://lowercase-proxy:8080";
    expect(resolveProxyUrl()).toBe("http://lowercase-proxy:8080");
  });

  it("picks up HTTP_PROXY env var when HTTPS_PROXY is absent", () => {
    process.env.HTTP_PROXY = "http://http-env-proxy:3128";
    expect(resolveProxyUrl()).toBe("http://http-env-proxy:3128");
  });

  it("picks up ALL_PROXY env var as lowest env priority", () => {
    process.env.ALL_PROXY = "http://all-proxy:1080";
    expect(resolveProxyUrl()).toBe("http://all-proxy:1080");
  });

  it("HTTPS_PROXY wins over HTTP_PROXY", () => {
    process.env.HTTPS_PROXY = "http://https-proxy:8080";
    process.env.HTTP_PROXY = "http://http-proxy:3128";
    expect(resolveProxyUrl()).toBe("http://https-proxy:8080");
  });

  it("skips blank env var values", () => {
    process.env.HTTPS_PROXY = "   ";
    process.env.HTTP_PROXY = "http://http-proxy:3128";
    expect(resolveProxyUrl()).toBe("http://http-proxy:3128");
  });

  describe("macOS scutil fallback", () => {
    const savedPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
    });

    it("calls scutil on darwin when no env var or config is set", () => {
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout:
          "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 8080\n  HTTPSProxy : scutil-proxy.example.com\n}",
        stderr: "",
        pid: 1234,
        output: [],
        signal: null,
      });

      expect(resolveProxyUrl()).toBe("http://scutil-proxy.example.com:8080");
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "scutil",
        ["--proxy"],
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("does not call scutil when env var is set", () => {
      process.env.HTTPS_PROXY = "http://env-proxy:8888";
      expect(resolveProxyUrl()).toBe("http://env-proxy:8888");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it("does not call scutil when config proxy is set", () => {
      expect(resolveProxyUrl("http://config-proxy:1234")).toBe("http://config-proxy:1234");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it("returns undefined when scutil exits non-zero", () => {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error",
        pid: 1234,
        output: [],
        signal: null,
      });
      expect(resolveProxyUrl()).toBeUndefined();
    });

    it("returns undefined when scutil throws", () => {
      spawnSyncMock.mockImplementation(() => {
        throw new Error("scutil not found");
      });
      expect(resolveProxyUrl()).toBeUndefined();
    });

    it("returns undefined when scutil finds no proxy configured", () => {
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: "<dictionary> {\n  ExceptionsList : <array> { 0 : *.local }\n}",
        stderr: "",
        pid: 1234,
        output: [],
        signal: null,
      });
      expect(resolveProxyUrl()).toBeUndefined();
    });
  });

  describe("non-darwin platforms", () => {
    const savedPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
    });

    it("does not call scutil on linux", () => {
      expect(resolveProxyUrl()).toBeUndefined();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });
});
