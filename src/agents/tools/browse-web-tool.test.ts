import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowseWebTool } from "./browse-web-tool.js";

const FAKE_SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const FAKE_RESPONSE = {
  success: true,
  final_url: "https://example.com/result",
  content: "The page shows pricing: Basic $10/mo, Pro $25/mo.",
  screenshot: FAKE_SCREENSHOT,
  steps: [
    { step: 1, action: "navigate", url: "https://example.com" },
    { step: 2, action: "click#pricing", url: "https://example.com/pricing" },
  ],
  error: undefined,
};

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  } as unknown as Response);
}

describe("createBrowseWebTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.BROWSERUSE_URL;
  });

  it("returns task result on success", async () => {
    const fetchMock = mockFetch(FAKE_RESPONSE);
    const tool = createBrowseWebTool({
      browseuseUrl: "http://browseruse:8080",
      fetchFn: fetchMock,
    });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", {
      task: "Find pricing plans",
      url_hint: "example.com",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://browseruse:8080/browse");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.task).toBe("Find pricing plans");
    expect(body.url_hint).toBe("example.com");

    const typed = result as {
      content: { text: string }[];
      details: typeof FAKE_RESPONSE;
    };
    expect(typed.details.success).toBe(true);
    expect(typed.details.final_url).toBe("https://example.com/result");
    expect(typed.details.steps).toHaveLength(2);
    expect(typed.content[0].text).toContain("2 steps");
    expect(typed.content[0].text).toContain("https://example.com/result");
  });

  it("includes error in result summary when task fails", async () => {
    const failResponse = {
      success: false,
      final_url: "",
      content: "",
      screenshot: "",
      steps: [],
      error: "Task timed out after 30s",
    };
    const fetchMock = mockFetch(failResponse);
    const tool = createBrowseWebTool({
      browseuseUrl: "http://browseruse:8080",
      fetchFn: fetchMock,
    });

    const result = await tool!.execute("call-2", { task: "Do something slow" });
    const typed = result as { content: { text: string }[] };
    expect(typed.content[0].text).toContain("Task timed out after 30s");
    expect(typed.content[0].text).toContain("failed");
  });

  it("throws ToolInputError when task is missing", async () => {
    const { ToolInputError } = await import("./common.js");
    const tool = createBrowseWebTool({ browseuseUrl: "http://browseruse:8080" });
    await expect(tool!.execute("call-3", {})).rejects.toThrow(ToolInputError);
  });

  it("throws when service returns non-OK", async () => {
    const fetchMock = mockFetch({ detail: "Internal Server Error" }, 500);
    const tool = createBrowseWebTool({
      browseuseUrl: "http://browseruse:8080",
      fetchFn: fetchMock,
    });
    await expect(tool!.execute("call-4", { task: "anything" })).rejects.toThrow(
      /BrowserUse service error/,
    );
  });

  it("uses BROWSERUSE_URL env var when no url option provided", async () => {
    process.env.BROWSERUSE_URL = "http://env-host:9090";
    const fetchMock = mockFetch(FAKE_RESPONSE);
    const tool = createBrowseWebTool({ fetchFn: fetchMock });
    expect(tool).not.toBeNull();

    await tool!.execute("call-5", { task: "anything" });
    const url = (fetchMock.mock.calls[0] as [string, RequestInit])[0];
    expect(url).toBe("http://env-host:9090/browse");
  });

  it("returns null when no URL is configured", () => {
    delete process.env.BROWSERUSE_URL;
    const result = createBrowseWebTool({});
    expect(result).toBeNull();
  });

  it("sends max_steps and timeout_seconds when provided", async () => {
    const fetchMock = mockFetch(FAKE_RESPONSE);
    const tool = createBrowseWebTool({
      browseuseUrl: "http://browseruse:8080",
      fetchFn: fetchMock,
    });
    await tool!.execute("call-6", { task: "fast task", max_steps: 3, timeout_seconds: 10 });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body.max_steps).toBe(3);
    expect(body.timeout_seconds).toBe(10);
  });
});
