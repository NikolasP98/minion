import { describe, expect, it, vi } from "vitest";
import { createSlackDraftStream } from "./draft-stream.js";

type DraftStreamParams = Parameters<typeof createSlackDraftStream>[0];
type DraftSendFn = NonNullable<DraftStreamParams["send"]>;
type DraftEditFn = NonNullable<DraftStreamParams["edit"]>;
type DraftRemoveFn = NonNullable<DraftStreamParams["remove"]>;
type DraftWarnFn = NonNullable<DraftStreamParams["warn"]>;

function createDraftStreamHarness(
  params: {
    maxChars?: number;
    send?: DraftSendFn;
    edit?: DraftEditFn;
    remove?: DraftRemoveFn;
    warn?: DraftWarnFn;
  } = {},
) {
  const send =
    params.send ??
    vi.fn<DraftSendFn>(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
  const edit = params.edit ?? vi.fn<DraftEditFn>(async () => {});
  const remove = params.remove ?? vi.fn<DraftRemoveFn>(async () => {});
  const warn = params.warn ?? vi.fn<DraftWarnFn>();
  const stream = createSlackDraftStream({
    target: "channel:C123",
    token: "xoxb-test",
    throttleMs: 250,
    maxChars: params.maxChars,
    send,
    edit,
    remove,
    warn,
  });
  return { stream, send, edit, remove, warn };
}

describe("createSlackDraftStream", () => {
  it("sends the first update and edits subsequent updates", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("C123", "111.222", "hello world", {
      token: "xoxb-test",
      accountId: undefined,
    });
  });

  it("does not send duplicate text", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("same");
    await stream.flush();
    stream.update("same");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);
  });

  it("supports forceNewMessage for subsequent assistant messages", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce({ channelId: "C123", messageId: "111.222" })
      .mockResolvedValueOnce({ channelId: "C123", messageId: "333.444" });
    const { stream, edit } = createDraftStreamHarness({ send });

    stream.update("first");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("second");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(0);
    expect(stream.messageId()).toBe("333.444");
  });

  it("stops when text exceeds max chars", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxChars: 5 });

    stream.update("123456");
    await stream.flush();
    stream.update("ok");
    await stream.flush();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clear removes preview message when one exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("C123", "111.222", {
      token: "xoxb-test",
      accountId: undefined,
    });
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });

  it("clear is a no-op when no preview message exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    await stream.clear();

    expect(remove).not.toHaveBeenCalled();
  });

  describe("platformAcceptedNotEditable sentinel (webhook / no-message-id mode)", () => {
    it("does not create duplicate messages at tool boundaries when send returns unknown messageId", async () => {
      // Simulates Slack webhook mode: send succeeds but returns no ts → "unknown"
      const send = vi.fn<DraftSendFn>(async () => ({
        channelId: "C123",
        messageId: "unknown",
      }));
      const { stream, edit } = createDraftStreamHarness({ send });

      // First update — enters first-send path, gets "unknown" messageId
      stream.update("hello");
      await stream.flush();
      expect(send).toHaveBeenCalledTimes(1);

      // Tool boundary — forceNewMessage() must NOT reset IDs
      stream.forceNewMessage();

      // Second update — must NOT re-enter first-send path
      stream.update("hello world");
      await stream.flush();

      expect(send).toHaveBeenCalledTimes(1); // no new send
      expect(edit).not.toHaveBeenCalled(); // no edit attempt with "unknown"
    });

    it("skips edit API calls silently when sentinel is active", async () => {
      const send = vi.fn<DraftSendFn>(async () => ({
        channelId: "C123",
        messageId: "unknown",
      }));
      const edit = vi.fn<DraftEditFn>(async () => {});
      const stream = createSlackDraftStream({
        target: "channel:C123",
        token: "xoxb-test",
        throttleMs: 250,
        send,
        edit,
      });

      stream.update("first");
      await stream.flush();
      // Without forceNewMessage: streamChannelId + streamMessageId are set,
      // so the next update hits the edit branch — sentinel should make it a no-op
      stream.update("second");
      await stream.flush();

      expect(send).toHaveBeenCalledTimes(1);
      expect(edit).not.toHaveBeenCalled();
    });

    it("does not attempt to delete message when sentinel is active", async () => {
      const send = vi.fn<DraftSendFn>(async () => ({
        channelId: "C123",
        messageId: "unknown",
      }));
      const remove = vi.fn<DraftRemoveFn>(async () => {});
      const { stream } = createDraftStreamHarness({ send, remove });

      stream.update("hello");
      await stream.flush();
      await stream.clear();

      expect(remove).not.toHaveBeenCalled();
    });

    it("allows subsequent forceNewMessage calls without creating extra sends", async () => {
      const send = vi.fn<DraftSendFn>(async () => ({
        channelId: "C123",
        messageId: "unknown",
      }));
      const { stream } = createDraftStreamHarness({ send });

      stream.update("update 1");
      await stream.flush();
      stream.forceNewMessage();
      stream.update("update 2");
      await stream.flush();
      stream.forceNewMessage();
      stream.update("update 3");
      await stream.flush();
      stream.forceNewMessage();
      stream.update("update 4");
      await stream.flush();

      // Only the very first send should have gone out
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("clear warns when cleanup fails", async () => {
    const remove = vi.fn<DraftRemoveFn>(async () => {
      throw new Error("cleanup failed");
    });
    const warn = vi.fn<DraftWarnFn>();
    const { stream } = createDraftStreamHarness({ remove, warn });

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(warn).toHaveBeenCalledWith("slack stream preview cleanup failed: cleanup failed");
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });
});
