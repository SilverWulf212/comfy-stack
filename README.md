# comfy-stack

Self-hosted AI image generation pipeline with a Claude-Code-driven MCP tool, a public web gallery, and Real-ESRGAN upscaling — all coordinated around a single 8 GB RTX 4060 shared with a local Ollama LLM stack.

```
Claude Code  ─►  comfy-mcp (MCP stdio)  ─►  ComfyUI (Z-Image Turbo, GPU)
                                              │
                                              ▼
                                       /gallery/<sha>.png
                                              │
                                              ▼
                              stock-gallery (dynamic Node UI)
                                              │
                                       upscale → Real-ESRGAN → sharp.js → /gallery/<sha>.webp
                                              │
                                              ▼
                                  https://stock.silverwulf.com
```

## Components

| Path | What it does |
|---|---|
| `comfy-mcp/` | Stdio MCP server exposing `generate_image` to Claude Code. Stops Ollama, calls ComfyUI's `/prompt`, drops the PNG into `/gallery/`, restarts and warms Ollama. |
| `stock-gallery/` | Node HTTP server. Renders the gallery dynamically from the `/gallery/` directory, serves images, exposes `/api/upscale` (Real-ESRGAN via the same ComfyUI) and `/api/download-zip`. Replaces the original nginx-only static container. |
| `workflows/` | Parameterised ComfyUI workflows. `zimage-default.json` for image gen, `upscale.json` for Real-ESRGAN x4 + sharpen. |
| `images-proxy/` | Legacy nginx → MinIO bridge for `images.silverwulf.work` (kept for archival; not used by the current pipeline). |

## Coordination model

ComfyUI and Ollama share the same RTX 4060. Only one model fits at a time, so:

1. `comfy-mcp` (or `stock-gallery` upscale) acquires `/state/comfy-gpu.lock`.
2. Stops the `ollama` container via the Docker socket.
3. Submits a workflow to ComfyUI on `comfyui:8188`.
4. Polls history, fetches the output PNG.
5. (Upscale path: passes through `sharp.js` → 2048² → WebP q90, deletes the original PNG.)
6. Restarts Ollama, warms the gen + embed models.
7. Releases the lock.

A cron-driven `comfy-watchdog.sh` runs every 5 minutes and silently no-ops while the lock is present, but recovers Ollama if it ever crashes outside the lock.

## Aesthetic

The web UI is intentionally **not** a generic Tailwind grid. It is a "dark editorial archive" — Fraunces serif display, JetBrains Mono technical metadata, warm near-black paper, single vermilion accent for selection and CTAs, paper-grain overlay, staggered tile reveal. See `stock-gallery/server.mjs::renderIndex`.

## Setup notes (specific gotchas hit during the build)

- **`yanwk/comfyui-boot:cu124-slim` ships ComfyUI v0.18.5 but forgets to install `comfy_aimdo`.** A `pre-start.sh` hook in the `comfyui_data` named volume installs it on every boot.
- **`qwen_3_4b_fp8_mixed.safetensors` text encoder does NOT load** in this ComfyUI version (`AttributeError: 'NoneType' object has no attribute 'Params'`). Use the bf16 variant — ComfyUI offloads it to CPU RAM as needed.
- **`mcpServers` is rejected by the `~/.claude/settings.json` schema.** Use `claude mcp add-json --scope user comfy-mcp '...'` instead — it writes to `~/.claude.json`.
- **Let's Encrypt TLS-ALPN-01 fails against the bare home IP** (the Coolify Traefik handshake returns `tls: unrecognized name`). Cloudflare Tunnel terminates TLS at the edge instead — `stock.silverwulf.com` routes through the existing `cloudflared` service to `localhost:80`.

## Local invocation

```bash
# Generate via the MCP tool (from a Claude Code session that has comfy-mcp registered)
mcp__comfy-mcp__generate_image  prompt="…"

# Or hit the gallery API directly
curl -X POST https://stock.silverwulf.com/api/upscale \
  -H 'content-type: application/json' \
  -d '{"files":["abc1234567890def.png"]}'

curl -X POST https://stock.silverwulf.com/api/download-zip \
  -H 'content-type: application/json' \
  -d '{"files":["abc1234567890def.png"]}' \
  -o batch.zip
```

## Hardware profile

- AMD Ryzen 5 3600 · 32 GB RAM · NVIDIA RTX 4060 (8 GB)
- Ollama models warmed: `qwen3.5:9b`, `qwen3.5:4b`, `nomic-embed-text`
- ComfyUI models: `z-image-turbo-Q5_K_M.gguf` · `qwen_3_4b.safetensors` · `ae.safetensors` · `RealESRGAN_x4plus.pth`

## License

MIT. AI-generated imagery in the gallery is CC.
