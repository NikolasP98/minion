# Weixin/WeChat Channel Adapter

OpenClaw adapter for personal WeChat messaging via the **iLink Bot API**.

## Overview

This adapter connects OpenClaw to personal WeChat accounts using Tencent's iLink Bot API. Unlike the WeCom (Enterprise WeChat) API which requires business registration, the iLink Bot API works with personal WeChat accounts via QR code login.

**Phase 1 scope:** Text echo bot with inbound normalization and basic outbound text sending. Media support (images, voice, video, files) requires AES-128-ECB CDN encryption and is planned for Phase 2.

## Architecture

- **Transport:** Long-polling via `/ilink/bot/getupdates` (no webhook callbacks)
- **Auth:** QR code login flow producing a persistent `bot_token`
- **Message types (Phase 1):** Text only (type=1)
- **Message types (planned):** Image (type=2), Voice (type=3), File (type=4), Video (type=5)

## Setup / Registration Process

### 1. No app registration required

The iLink Bot API does not require creating an app on a developer portal. Your personal WeChat account IS the bot identity.

### 2. QR Code Login

1. Start the adapter — it will call `GET /ilink/bot/get_bot_qrcode?bot_type=3`
2. A QR code is displayed (or returned as base64 data URL)
3. Scan the QR code with your personal WeChat app
4. The adapter polls `GET /ilink/bot/get_qrcode_status` until confirmed
5. On confirmation, a `bot_token` is returned and persisted

### 3. Configuration

Add to your OpenClaw config:

```yaml
channels:
  weixin:
    enabled: true
    botToken: "<your-bot-token>"   # obtained from QR login
    # Optional overrides:
    # baseUrl: "https://ilinkai.weixin.qq.com"
    # pollTimeoutSec: 35
    # dmPolicy: "open"           # open | pairing | allowlist
    # allowFrom: ["123456789"]   # sender UIN allowlist
    # groupPolicy: "allowlist"   # open | allowlist | disabled
    # requireMention: true
```

### 4. Token persistence

The `bot_token` is long-lived and does not require periodic refresh. Store it securely (never commit to git). You can specify `tokenFile` to point to an external file.

## API Reference

- **iLink Bot API docs:** https://developer.work.weixin.qq.com/document/path/91907
- **Base URL:** `https://ilinkai.weixin.qq.com`

### Key endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ilink/bot/get_bot_qrcode` | GET | Start QR login |
| `/ilink/bot/get_qrcode_status` | GET | Poll login status |
| `/ilink/bot/getbotinfo` | POST | Health check / bot info |
| `/ilink/bot/getupdates` | POST | Long-poll for messages |
| `/ilink/bot/sendmessage` | POST | Send a message |

### Authentication headers

All requests include:

```
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
X-WECHAT-UIN: <base64-encoded random uint32>  # anti-replay nonce
```

## GFW / International Access

The iLink API endpoint (`ilinkai.weixin.qq.com`) is hosted by Tencent and is **likely accessible** from outside mainland China, but this has not been widely confirmed. The CDN for media (`novac2c.cdn.weixin.qq.com`) may have higher latency from non-China regions. Test connectivity from your deployment server before relying on this adapter.

## Limitations (Phase 1)

- **Text only** — media send/receive requires AES-128-ECB encryption (Phase 2)
- **No webhook callbacks** — uses long-polling only
- **No documented rate limits** — empirical testing recommended
- **No message editing** — iLink API does not support edit/unsend
- **No reactions** — not available in the iLink API
- **QR login wait** — full polling flow not yet automated (Phase 1)

## File Structure

```
extensions/weixin/
  index.ts              # Plugin entry point + exports
  minion.plugin.json    # Runtime manifest
  package.json          # npm + openclaw metadata
  README.md             # This file
  src/
    accounts.ts         # Config resolution + multi-account merging
    channel.ts          # ChannelPlugin definition
    client.ts           # iLink Bot API HTTP client
    monitor.ts          # Long-poll inbound message loop
    normalize.ts        # Inbound message normalization
    normalize.test.ts   # Tests for normalization
    outbound.ts         # ChannelOutboundAdapter
    probe.ts            # Health check probe
    runtime.ts          # Plugin runtime holder
    send.ts             # Outbound message sending
    targets.ts          # Target string normalization
    targets.test.ts     # Tests for target resolution
    types.ts            # TypeScript types
```
