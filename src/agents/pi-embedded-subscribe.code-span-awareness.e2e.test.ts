import { describe, expect, it, vi } from "vitest";
import { createStubSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession thinking tag code span awareness", () => {
  function createPartialReplyHarness() {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    return { emit, onPartialReply };
  }

  it("does not strip thinking tags inside inline code backticks", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "The fix strips leaked `<thinking>` tags from messages.",
      },
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    expect(lastCall[0].text).toContain("`<thinking>`");
  });

  it("does not strip thinking tags inside fenced code blocks", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Example:\n  ````\n<thinking>code example</thinking>\n  ````\nDone.",
      },
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    expect(lastCall[0].text).toContain("<thinking>code example</thinking>");
  });

  it("preserves thinking tags that appear mid-prose (after visible content)", () => {
    // When <thinking> appears after visible text, it is treated as prose context
    // (e.g. the model echoing a tag from a user message or tool result) and
    // the content inside is preserved rather than suppressed.
    const { emit, onPartialReply } = createPartialReplyHarness();

    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello <thinking>internal thought</thinking> world",
      },
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    // <thinking> appears after "Hello " (visible content) → prose context, not stripped
    expect(lastCall[0].text).toContain("internal thought");
    expect(lastCall[0].text).toContain("Hello");
    expect(lastCall[0].text).toContain("world");
  });

  describe("prose context protection (MIN-396)", () => {
    it("does not suppress text after <think> that appears mid-prose (after visible content)", () => {
      // When the model echos a <think> tag from a user message or tool result in its
      // response (not as structured reasoning), the content should not be suppressed.
      const { emit, onPartialReply } = createPartialReplyHarness();

      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "The tool returned: <think>data from external source</think> and here is my analysis.",
        },
      });

      expect(onPartialReply).toHaveBeenCalled();
      const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
      // "data from external source" must NOT be suppressed since <think> appeared after prose
      expect(lastCall[0].text).toContain("data from external source");
      expect(lastCall[0].text).toContain("The tool returned:");
      expect(lastCall[0].text).toContain("and here is my analysis.");
    });

    it("still strips <think> block when it appears at the very start of model output (genuine reasoning)", () => {
      const { emit, onPartialReply } = createPartialReplyHarness();

      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "<think>reasoning content</think>Here is my answer.",
        },
      });

      expect(onPartialReply).toHaveBeenCalled();
      const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
      // Reasoning at start should still be stripped
      expect(lastCall[0].text).not.toContain("reasoning content");
      expect(lastCall[0].text).toContain("Here is my answer.");
    });

    it("does not suppress content when <think> appears in second streaming chunk after visible text", () => {
      // Simulates: chunk 1 = visible text, chunk 2 = <think>from tool result</think>rest
      const { session, emit } = createStubSessionHarness();
      const onPartialReply = vi.fn();

      subscribeEmbeddedPiSession({ session, runId: "run", onPartialReply });

      emit({ type: "message_start", message: { role: "assistant" } });
      // First chunk with visible content
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "Here is the result: " },
      });
      // Second chunk with <think> from echoed tool context
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "<think>echoed tool data</think> done." },
      });

      const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
      expect(lastCall[0].text).toContain("echoed tool data");
      expect(lastCall[0].text).toContain("Here is the result:");
      expect(lastCall[0].text).toContain("done.");
    });

    it("strips <think> when it appears after only whitespace at the start of output", () => {
      const { emit, onPartialReply } = createPartialReplyHarness();

      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "  \n<think>reasoning here</think>Answer text.",
        },
      });

      expect(onPartialReply).toHaveBeenCalled();
      const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
      // Whitespace-only prefix should not count as "visible content"
      expect(lastCall[0].text).not.toContain("reasoning here");
      expect(lastCall[0].text).toContain("Answer text.");
    });
  });
});
