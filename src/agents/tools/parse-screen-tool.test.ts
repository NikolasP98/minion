import { beforeEach, describe, expect, it, vi } from "vitest";
import { createParseScreenTool } from "./parse-screen-tool.js";

// Minimal valid 1×1 PNG base64
const FAKE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const FAKE_RESPONSE = {
  labeled_screenshot: FAKE_B64,
  elements: [
    { id: 0, label: "button", bbox: [0.1, 0.2, 0.3, 0.4], type: "button", clickable: true },
    { id: 1, label: "input", bbox: [0.5, 0.1, 0.9, 0.2], type: "input", clickable: true },
    { id: 2, label: "icon", bbox: [0.0, 0.0, 0.05, 0.05], type: "icon", clickable: false },
  ],
};

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  } as unknown as Response);
}

describe("createParseScreenTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.OMNIPARSER_URL;
  });

  it("returns labeled_screenshot and elements on success", async () => {
    const fetchMock = mockFetch(FAKE_RESPONSE);
    const tool = createParseScreenTool({
      omniparserUrl: "http://omniparser:8080",
      fetchFn: fetchMock,
    });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", {
      screenshot: FAKE_B64,
      detail_level: "high",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://omniparser:8080/parse");
    expect(JSON.parse(init.body as string)).toMatchObject({
      screenshot: FAKE_B64,
      detail_level: "high",
    });

    const typed = result as { content: { text: string }[]; details: typeof FAKE_RESPONSE };
    expect(typed.details.elements).toEqual(FAKE_RESPONSE.elements);
    expect(typed.details.labeled_screenshot).toBe(FAKE_B64);
    // Summary text should mention element count
    expect(typed.content[0].text).toContain("3");
  });

  it("defaults detail_level to 'high' when omitted", async () => {
    const fetchMock = mockFetch(FAKE_RESPONSE);
    const tool = createParseScreenTool({
      omniparserUrl: "http://omniparser:8080",
      fetchFn: fetchMock,
    });
    await tool!.execute("call-2", { screenshot: FAKE_B64 });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.detail_level).toBe("high");
  });

  it("throws ToolInputError when screenshot is missing", async () => {
    const { ToolInputError } = await import("./common.js");
    const tool = createParseScreenTool({ omniparserUrl: "http://omniparser:8080" });
    await expect(tool!.execute("call-3", {})).rejects.toThrow(ToolInputError);
  });

  it("throws when omniparser service returns non-OK", async () => {
    const fetchMock = mockFetch({ detail: "Service Unavailable" }, 503);
    const tool = createParseScreenTool({
      omniparserUrl: "http://omniparser:8080",
      fetchFn: fetchMock,
    });
    await expect(tool!.execute("call-4", { screenshot: FAKE_B64 })).rejects.toThrow(
      /OmniParser service error/,
    );
  });

  it("uses OMNIPARSER_URL env var when no url option provided", async () => {
    process.env.OMNIPARSER_URL = "http://env-host:9090";
    const fetchMock = mockFetch(FAKE_RESPONSE);
    const tool = createParseScreenTool({ fetchFn: fetchMock });
    expect(tool).not.toBeNull();

    await tool!.execute("call-5", { screenshot: FAKE_B64 });
    const url = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
    expect(url).toBe("http://env-host:9090/parse");
  });

  it("returns null when no URL is configured", () => {
    delete process.env.OMNIPARSER_URL;
    const result = createParseScreenTool({});
    expect(result).toBeNull();
  });
});
