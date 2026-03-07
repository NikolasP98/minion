# Discord Multi-Account Setup

Run multiple Discord bots from a single Minion gateway, each bound to a different agent.

## Quick Start

```bash
minion channel add discord --token "YOUR_BOT_TOKEN" --account-name my-bot --agent main
```

## Account Structure in gateway.json

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "startupStaggerMs": 2000,
      "accounts": {
        "default": { "token": "BOT_TOKEN_1", "enabled": true },
        "renzo": { "token": "BOT_TOKEN_2", "enabled": true },
        "farquaad": { "token": "BOT_TOKEN_3", "enabled": true }
      }
    }
  }
}
```

Each key under `accounts` is the **account ID** used in bindings and routing.

## Per-Bot Agent Bindings

Bind each bot account to a specific agent using `accountId` in the binding match:

```json
{
  "bindings": [
    { "agentId": "panik", "match": { "channel": "discord", "accountId": "default" } },
    { "agentId": "renzo_bot", "match": { "channel": "discord", "accountId": "renzo" } },
    { "agentId": "farquaad", "match": { "channel": "discord", "accountId": "farquaad" } }
  ]
}
```

Without `accountId`, all Discord messages match the first binding — causing all bots to route to the same agent.

## Guild Allowlist

Restrict bots to specific servers and channels:

```json
{
  "channels": {
    "discord": {
      "accounts": {
        "default": {
          "token": "...",
          "guilds": {
            "1479698518389030962": {
              "channels": { "general": {} }
            }
          }
        }
      }
    }
  }
}
```

Guild and channel entries can use IDs or names — names are resolved to IDs at startup.

## CLI Usage

```bash
# Add a new bot account
minion channel add discord --token "TOKEN" --account-name my-bot

# Add and bind to an agent in one step
minion channel add discord --token "TOKEN" --account-name my-bot --agent ops

# Safe config editing (avoids jq drift)
bun run scripts/edit-gateway-config.ts --set 'channels.discord.accounts.newbot.token=TOKEN'
```

## Startup Stagger

When multiple accounts are configured, bots start sequentially with a 2-second delay (default) to avoid Discord API rate limits. Configure via:

```json
{ "channels": { "discord": { "startupStaggerMs": 3000 } } }
```

Set to `0` to disable staggering.

## Troubleshooting

### "Failed to resolve Discord application id"

Multiple bots calling the Discord API concurrently at startup. Fixed by the in-flight deduplication cache in `probe.ts`. If it persists, increase `startupStaggerMs`.

### Bot not starting

- Check `enabled: true` in the account config
- Verify the token is valid: `minion doctor`
- Check logs for rate limit errors

### Wrong agent responding

Ensure bindings include `accountId` matching the account key. Without it, the first matching Discord binding wins for all accounts.

### Config drift after jq editing

Use `minion channel add discord` or `scripts/edit-gateway-config.ts` instead of `jq` to avoid field reordering that triggers false hot-reload detections.
