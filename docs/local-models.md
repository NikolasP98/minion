# Local Models (Phi-4 14B via Ollama)

Minion can run **Phi-4 14B** (and other local models) via [Ollama](https://ollama.ai), keeping all inference on-device for maximum privacy.

## Requirements

- **RAM**: 16 GB or more (Phi-4 14B requires ~10–12 GB VRAM/RAM at 4-bit quantisation)
- **Disk**: ~10 GB free for the model weights
- **Ollama**: v0.4.0 or later

## Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.ai/install.sh | sh

# macOS via Homebrew
brew install ollama
```

Then start the Ollama daemon:

```bash
ollama serve
```

## Pull Phi-4 14B

```bash
ollama pull phi4
```

This downloads the Phi-4 14B model (~8 GB, 4-bit quantised). Verify it works:

```bash
ollama run phi4 "Say hello."
```

## Configure Minion to use Phi-4

### Option A — Select per request

Set the provider to `ollama` and model to `phi-4` or `phi4:14b` in your Minion config:

```jsonc
{
  "agents": {
    "defaults": {
      "provider": "ollama",
      "model": "phi-4"
    }
  }
}
```

### Option B — Privacy Mode (all requests local)

Set the `MINION_PRIVACY_MODE` environment variable to force every inference call to the local Ollama provider:

```bash
export MINION_PRIVACY_MODE=true
```

When privacy mode is enabled:
- All LLM requests are routed to `ollama` with model `phi-4` (override with `MINION_LOCAL_MODEL`).
- If the system has less than 16 GB RAM, a warning is logged and the original provider is used as a fallback.
- You can customise the local model: `MINION_LOCAL_MODEL=llama3:70b`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MINION_PRIVACY_MODE` | `false` | Set to `true` or `1` to route all inference to a local provider |
| `MINION_LOCAL_MODEL` | `phi-4` | Ollama model tag to use in privacy mode |

## Other supported Ollama models

Any model tag that contains `phi`, `qwen`, `llama3`, `gemma3`, or `deepseek-r1` is automatically routed through Ollama. Examples:

```bash
ollama pull llama3:8b
ollama pull qwen3:8b
ollama pull gemma3:12b
```

## Troubleshooting

**Connection refused** — Make sure Ollama is running (`ollama serve`) before starting Minion. The default base URL is `http://127.0.0.1:11434`.

**Out of memory** — Lower quantisation or use a smaller model variant. Phi-4 Mini is significantly smaller.

**Slow first response** — The model is loaded into memory on first use. Subsequent requests are faster.
