# MASP v0 — MINION App Server Protocol Baseline Specification

**Status:** Baseline (retrospective audit)
**Protocol version constant:** `3`
**Audit date:** 2026-04-10
**Author:** Senior Engineer (MIN-372)
**Approved by:** MIN-38 (CTO sign-off on Unified App Server Protocol architecture)

---

## 1. Overview

MASP (MINION App Server Protocol) is the WebSocket protocol spoken between
the MINION Gateway server and every first-party client surface:

| Client                       | Language / Library                    |
| ---------------------------- | ------------------------------------- |
| CLI / backend gateway client | TypeScript (`ws` package)             |
| Hub browser client           | TypeScript (native browser WebSocket) |
| macOS desktop app            | Swift (`URLSessionWebSocketTask`)     |
| iOS app                      | Swift (`URLSessionWebSocketTask`)     |
| Android app                  | Kotlin (future, same wire format)     |

This document captures the **implicit** protocol as it existed before MASP v1
versioning was introduced. It is the baseline ("v0") against which all future
additive changes will be diff'd.

The TypeScript type definitions are in [`src/protocol/v0.ts`](../src/protocol/v0.ts).
The authoritative runtime schemas are in
`src/gateway/protocol/schema/` in the Gateway repo.

---

## 2. Transport

- **Protocol:** WebSocket (RFC 6455)
- **Default URL:** `ws://127.0.0.1:18789`
- **TLS:** Supported (`wss://`); CLI client validates fingerprint for self-signed certs
- **Encoding:** JSON (UTF-8 text frames only)
- **Max message size:**
  - Gateway server: 25 MiB
  - Desktop clients: 16 MiB
  - Hub browser: browser-dependent (no explicit cap set)

---

## 3. Frame Format

Every message is a JSON object with a discriminating `type` field:

```
type GatewayFrame = RequestFrame | ResponseFrame | EventFrame
                    discriminated by: frame.type
```

### 3.1 REQUEST frame (`type: "req"`) — client → server

```jsonc
{
  "type": "req",
  "id": "<uuid>",        // unique per in-flight request
  "method": "chat.send", // method name
  "params": { ... }      // optional, method-specific
}
```

### 3.2 RESPONSE frame (`type: "res"`) — server → client

```jsonc
// Success:
{ "type": "res", "id": "<echoed-uuid>", "ok": true, "payload": { ... } }

// Error:
{
  "type": "res",
  "id": "<echoed-uuid>",
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Session not found",
    "details": { ... },     // optional
    "retryable": false,      // optional
    "retryAfterMs": 5000     // optional
  }
}
```

One RESPONSE is sent for each REQUEST; responses are never broadcast.

### 3.3 EVENT frame (`type: "event"`) — server → client (push)

```jsonc
{
  "type": "event",
  "event": "chat",           // event name
  "payload": { ... },        // optional, event-specific
  "seq": 42,                 // optional sequence number (per-connection, monotonic)
  "stateVersion": { "presence": 5, "health": 3 }  // optional
}
```

Events are unsolicited server push. Some events are broadcast to all
connections; others are scope-filtered (see Section 7).

---

## 4. Handshake Protocol

The handshake is a 3-message exchange that runs once when the WebSocket
connection is first accepted.

```
Client                              Server
  |                                   |
  |<--- EventFrame("connect.challenge") |   Phase 0: challenge
  |                                   |
  |-- RequestFrame(method="connect") -->|   Phase 1: connect
  |                                   |
  |<--- ResponseFrame(ok=true, HelloOk)|   Phase 2: hello-ok
  |                                   |
  |   (normal frame exchange begins)  |
```

### Phase 0 — Challenge (server → client)

Immediately on WebSocket accept, before the client speaks:

```jsonc
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "<uuid>", "ts": 1744300800000 },
}
```

The `nonce` must be echoed in `ConnectParams.device.nonce` if the client is
using device authentication (v2 signing).

### Phase 1 — Connect Request (client → server)

```jsonc
{
  "type": "req",
  "id": "<uuid>",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "minion-control-ui",
      "version": "2026.2.0",
      "platform": "web",
      "mode": "ui",
    },
    "caps": ["tool-events"],
    "auth": { "token": "<jwt>" },
    "locale": "en-US",
    "userAgent": "Mozilla/5.0 ...",
  },
}
```

Full `ConnectParams` type: see [`src/protocol/v0.ts`](../src/protocol/v0.ts#ConnectParams).

### Phase 2 — Hello OK (server → client)

```jsonc
{
  "type": "res",
  "id": "<echoed-uuid>",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "server": { "version": "2026.2.0", "connId": "<uuid>" },
    "features": {
      "methods": ["chat.send", "sessions.list", ...],
      "events": ["chat", "tick", "health", ...]
    },
    "snapshot": { ... },
    "policy": {
      "maxPayload": 26214400,
      "maxBufferedBytes": 8388608,
      "tickIntervalMs": 30000
    }
  }
}
```

After Phase 2, both parties exchange normal frames.

---

## 5. Keep-alive / Tick Protocol

The server broadcasts a `"tick"` event every `policy.tickIntervalMs`
milliseconds (default 30 000 ms):

```jsonc
{ "type": "event", "event": "tick", "payload": { "ts": 1744300830000 } }
```

**Client obligation:** Clients MUST treat tick absence as a stalled connection
and initiate a reconnect. The recommended threshold is approximately
3 × `tickIntervalMs`.

**Desktop keepalive quirk:** iOS/macOS clients additionally send a `health`
request every 15 s to keep NAT/proxy connections alive, independent of ticks.
This is a client-side workaround and not part of the protocol. Hub and CLI
clients rely solely on tick monitoring.

---

## 6. Method Registry

All methods are invoked via REQUEST frames. Every method name is a dot-separated
string. The full list is enumerated in the `GatewayMethod` type in `v0.ts`.

### Method categories (112 methods total)

| Category      | Count | Examples                                              |
| ------------- | ----- | ----------------------------------------------------- |
| Handshake     | 1     | `connect`                                             |
| Agents        | 10    | `agents.list`, `agent`, `agent.install`               |
| Chat          | 4     | `chat.send`, `chat.history`, `chat.abort`             |
| Sessions      | 10    | `sessions.list`, `sessions.patch`, `sessions.compact` |
| Nodes         | 11    | `node.invoke`, `node.pair.*`                          |
| Devices       | 6     | `device.pair.*`, `device.token.*`                     |
| Config        | 5     | `config.get`, `config.set`, `config.apply`            |
| Skills        | 4     | `skills.status`, `skills.install`                     |
| Models        | 1     | `models.list`                                         |
| Tools         | 4     | `tools.status`, `tools.reload`                        |
| TTS           | 6     | `tts.convert`, `tts.providers`                        |
| Voice wake    | 2     | `voicewake.get`, `voicewake.set`                      |
| Cron          | 7     | `cron.add`, `cron.run`, `cron.runs`                   |
| Approvals     | 6     | `exec.approval.request`, `exec.approvals.get`         |
| Web login     | 2     | `web.login.start`, `web.login.wait`                   |
| Channels      | 4     | `channels.status`, `talk.config`                      |
| System        | 6     | `health`, `status`, `system-event`                    |
| Logging       | 1     | `logs.tail`                                           |
| Reliability   | 3     | `reliability.events`, `update.run`                    |
| Memory / misc | 7     | `memory.snapshot`, `usage.cost`, `mesh.*`             |
| Wizard        | 4     | `wizard.start`, `wizard.next`                         |
| Outbound send | 2     | `send`, `poll`                                        |

---

## 7. Event Registry

Events are pushed via EVENT frames. Some events are broadcast to all
authenticated connections; scope-guarded events are filtered by the `scopes`
declared in `ConnectParams`.

| Event name                | Direction         | Scope guard          | Notes                           |
| ------------------------- | ----------------- | -------------------- | ------------------------------- |
| `connect.challenge`       | server→client     | —                    | Handshake only; not repeated    |
| `tick`                    | server→all        | —                    | 30 s keep-alive                 |
| `health`                  | server→all        | —                    | On state change                 |
| `chat`                    | server→subscribed | —                    | Streamed during agent execution |
| `agent`                   | server→subscribed | —                    | Agent lifecycle events          |
| `cron`                    | server→all        | —                    | Cron job state changes          |
| `shutdown`                | server→all        | —                    | Before server restart           |
| `heartbeat`               | server→all        | —                    | Agent loop heartbeat            |
| `voicewake.changed`       | server→all        | —                    | Voice wake config change        |
| `node.pair.requested`     | server→client     | `operator.pairing`   |                                 |
| `node.pair.resolved`      | server→client     | `operator.pairing`   |                                 |
| `node.invoke.request`     | server→node       | —                    | Sent to node connections only   |
| `device.pair.requested`   | server→client     | `operator.pairing`   |                                 |
| `device.pair.resolved`    | server→client     | `operator.pairing`   |                                 |
| `exec.approval.requested` | server→client     | `operator.approvals` | HITL gates                      |
| `exec.approval.resolved`  | server→client     | `operator.approvals` | HITL gates                      |
| `talk.mode`               | server→all        | —                    | Push-to-talk state              |
| `reliability`             | server→all        | —                    | Reliability event               |

---

## 8. Sequence Numbering

EVENT frames carry an optional `seq` integer. Clients SHOULD monitor for
sequence gaps (received `seq` > expected `seq + 1`) and either request a
resync or reconnect.

The Desktop Swift client explicitly surfaces `seqGap(expected:received:)` as
a first-class error case; the Hub/CLI clients accept gaps silently in MASP v0.

---

## 9. Client Comparison

The following table documents implementation differences across first-party
clients as found in the audit. **No wire-protocol discrepancies were found.**
All differences are implementation details or connection policy choices.

| Aspect              | CLI / Backend (`client.ts`) | Hub browser (`gateway.ts`)    | Desktop Swift (`GatewayChannel.swift`)        |
| ------------------- | --------------------------- | ----------------------------- | --------------------------------------------- |
| WebSocket library   | `ws` (Node.js)              | Native browser WebSocket      | `URLSessionWebSocketTask`                     |
| Connect `pathEnv`   | ✅ sent                     | ❌ omitted                    | ❌ omitted                                    |
| Connect `userAgent` | ❌ omitted                  | ✅ sent                       | ❌ omitted                                    |
| Connect `locale`    | ❌ omitted                  | ✅ sent                       | ❌ omitted                                    |
| Device identity     | ✅ supported                | ✅ supported (secure context) | ✅ required                                   |
| Keepalive mechanism | Tick watch only             | Tick watch only               | Tick watch + explicit `health` req every 15 s |
| Max frame size      | 25 MiB                      | Browser-dependent             | 16 MiB                                        |
| Methods called      | All 112                     | ~15 UI-focused                | ~12 core + generic `request()`                |
| Event handling      | Generic callback            | Generic callback              | Typed `GatewayPush` enum                      |
| Reconnect backoff   | Exponential (cap 30 s)      | Exponential (cap 15 s, ×1.7)  | Exponential                                   |
| Custom frame types  | None                        | None                          | None                                          |
| Custom event types  | None                        | None                          | None                                          |

### Discrepancies

No **protocol** discrepancies found. All three clients speak the same wire
format.

Minor **implementation** differences:

1. **`pathEnv` field** — only sent by CLI/backend; absent from browser and
   desktop clients. Gateway accepts it as optional, so no breakage.
2. **`userAgent` / `locale` fields** — only sent by browser clients.
3. **Explicit keepalive requests** — Desktop clients send `health` every 15 s
   as an additional NAT keep-alive beyond the server-side tick. This is not
   required by the protocol but is safe.
4. **Close code on connect failure** — Hub uses close code `4008` (custom)
   instead of `1008` ("Policy Violation") because browsers reject `1008`
   for client-initiated closes.
5. **Sequence gap handling** — Desktop surfaces `seqGap` explicitly; Hub/CLI
   accept gaps silently.

---

## 10. Error Codes

Error codes are returned in `ResponseFrame.error.code`. The full list is
in `src/gateway/protocol/schema/error-codes.ts`.

Common codes: `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_PARAMS`,
`INTERNAL_ERROR`, `TIMEOUT`, `METHOD_NOT_FOUND`.

---

## 11. Known Limitations (to address in MASP v1)

These limitations were identified during the audit and should be addressed
when implementing MASP v1 (see MIN-38):

1. **No protocol version negotiation at transport layer** — the `minProtocol` /
   `maxProtocol` fields exist in ConnectParams but the actual negotiated version
   is just `protocol` in HelloOk. There is no version rejection mechanism.
2. **Health payload is untyped** — `HealthSnapshotSchema = Type.Any()`. The
   health object shape is not formally specified.
3. **No per-event payload schemas** — most event payloads are typed as
   `unknown` in v0. MASP v1 should add formal schemas.
4. **Sequence gaps silently accepted by Hub/CLI** — only Desktop clients
   surface sequence gaps. A resync mechanism should be defined.
5. **Desktop 16 MiB cap vs server 25 MiB** — Desktop clients may silently
   drop large messages. This should be aligned in v1.

---

## 12. Files

| File                                                               | Purpose                                    |
| ------------------------------------------------------------------ | ------------------------------------------ |
| `src/protocol/v0.ts`                                               | TypeScript type definitions (this package) |
| `src/gateway/protocol/schema/frames.ts`                            | Authoritative TypeBox schemas              |
| `src/gateway/protocol/schema/snapshot.ts`                          | Snapshot / presence types                  |
| `src/gateway/protocol/client-info.ts`                              | Client ID / mode enums                     |
| `src/gateway/server-core/server-methods-list.ts`                   | Method & event registry                    |
| `ui/src/ui/gateway.ts`                                             | Hub browser client                         |
| `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift` | Desktop core                               |
