import type { InboundMessage } from "../channels/bus-types.js";

const DEFAULTS: InboundMessage = {
  id: "msg-test-1",
  channel: "whatsapp",
  type: "text",
  senderId: "whatsapp:+10001112222",
  senderName: "Test User",
  text: "hello",
  isDirect: true,
  isMention: false,
  timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
};

/**
 * Build an InboundMessage with sensible defaults, overriding any fields.
 */
export function buildInboundMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return { ...DEFAULTS, ...overrides };
}
