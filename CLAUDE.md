# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`comfy-stack` is a self-hosted AI image generation pipeline running on a single 8 GB RTX 4060 home server, sharing the GPU with a local Ollama LLM stack that other services depend on (notably `bayou-help`). It exposes both a Claude Code MCP tool (`mcp__comfy-mcp__generate_image`) and a public dark-editorial web gallery at `https://stock.silverwulf.com`. The repo is two Node services + parameterised ComfyUI workflow templates + a one-shot legacy nginx-MinIO bridge that's no longer in the live path.

The README has the high-level diagram and the GPU coordination story; do not duplicate that here. This file is the operational + architectural context an agent needs that the README doesn't already cover.

## Two-process model (the most important thing to internalise)

| Process | Lifetime | Run via | What it owns |
|---|---|---|---|
| `stock-gallery` | **long-running** Node 22 container | `docker run -d` with Traefik labels | All in-memory state: gen queue, worker loop, Redis client, finished history, the entire `cached()` layer. Single source of truth for HTTP traffic from `stock.silverwulf.com`. |
| `comfy-mcp` | **ephemeral** stdio MCP server | spawned per Claude Code tool call via `docker run -i --rm` | Nothing persistent. Process dies as soon as the MCP call completes. |

Both processes:
- write to the same `gallery/` host directory (atomic via tmp+rename)
- write to the same Redis `stockgal:*` namespace on `onyx-cache`
- coordinate GPU access via the same lock file `/state/comfy-gpu.lock`
- stop the local `ollama` container during their GPU work and restart+warm it after

This shared-state-but-disjoint-lifetime split is the source of the most subtle bugs in the codebase. When you change anything that touches the lock, the gallery folder, or Redis, audit BOTH files. The C1 deadlock fix in commit `7652062` is the canonical example: comfy-mcp had to start tagging its lock with an owner string so stock-gallery's `recoverStaleLock` could distinguish "stale comfy-mcp leftover" from "stock-gallery's own crash" from "live job in progress".

## The lock file dance

Single file: `/home/silverwulf/comfy-stack/state/comfy-gpu.lock`. Format: `<pid> <owner> <ISO-8601>`. Both `stock-gallery/server.mjs::acquireLock` and `comfy-mcp/server.mjs::acquireLock` write this; both `releaseLock` unlink it.

`recoverStaleLock` in `stock-gallery/server.mjs` runs at boot and has two recovery paths:

1. **Own lock** (`"stock-gallery"` substring) → unconditional reap. We crashed mid-job by definition if we're booting.
2. **Foreign lock** (anything else) → reap if mtime older than `STALE_LOCK_MAX_AGE_MS` (6 minutes = `POLL_TIMEOUT_MS + 60s`). This breaks the comfy-mcp deadlock scenario where the cron watchdog refuses to restart Ollama while a stale lock exists.

There is also `~/.local/bin/comfy-watchdog.sh` running every 5 minutes via cron. It explicitly **no-ops while the lock exists**, so a leaked lock is the worst class of failure — it deadlocks gen, upscale, AND Bayou's Ollama dependency at the same time.

## Workflow templates

`workflows/zimage-default.json` and `workflows/upscale.json` are ComfyUI graph JSON with `{{placeholder}}` substitution slots. Both server files have a `deepReplace` function that substitutes them. **The two `deepReplace` impls were divergent in v1** — one would coerce numeric placeholders to strings and break `EmptySD3LatentImage`. They are now identical and both have the smart "whole-string returns raw value" branch. If you fork or refactor, keep them in lockstep.

Workflow placeholders in current use: `{{prompt}}`, `{{negative_prompt}}`, `{{seed}}`, `{{steps}}`, `{{cfg}}`, `{{width}}`, `{{height}}` (gen), `{{input_image}}` (upscale).

## Sidecar metadata

Every gen writes `gallery/<sha256[:16]>.json` next to its image. Schema:

```json
{
  "prompt": "raw user input",
  "enhancedPrompt": "post-LLM-rewrite text",
  "enhanceFailed": false,
  "style": "photo",
  "tags": ["cat", "windowsill"],
  "orientation": "square",
  "width": 1024,
  "height": 1024,
  "steps": 9,
  "cfg": 1.0,
  "seed": 1234567890,
  "model": "z-image-turbo Q5_K_M",
  "createdAt": "2026-04-08T13:18:44.824Z",
  "jobId": 1775654061235,
  "source": "stock-gallery|comfy-mcp"
}
```

Sidecars are bulk-loaded server-side at render time (`readAllSidecars` → embedded as `data-*` attrs on tiles) so the client never makes per-tile fetches. The upscale path renames `<hash>.png → <hash>.webp` and unlinks the original PNG, but the sidecar `<hash>.json` is **never touched** — it survives intact because the basename is the same.

`comfy-mcp` writes `tags: []` (no LLM rewriter in that path); only the gallery's gen queue extracts tags.

## Redis caching

Reuses the existing `onyx-cache` container shared with Bayou (different key prefix). Three keys:

| Key | TTL | Invalidated on |
|---|---|---|
| `stockgal:sidecars` | 300 s | gen done, upscale done |
| `stockgal:tagindex` | 300 s | gen done, upscale done |
| `stockgal:html:p<page>:t<tag>` | 60 s (planned to bump to 300 s in v3) | wildcard `SCAN+DEL` on gen/upscale done |

The `cached(key, ttl, fn)` helper falls through to direct computation if Redis is down (`redisOk` flag, `lazyConnect: true`, `retryStrategy: () => null`, `enableOfflineQueue: false`). **Never put user-controlled values inside Redis keys** — only the page number and tag (which are themselves validated). Bayou's keys are unprefixed; we share the same DB but namespace via `stockgal:*`.

## How to rebuild and redeploy

There is **no `node`, `npm`, or `cargo` on the host**. Everything runs in Docker.

```bash
# Syntax check (fast iteration without rebuild)
docker run --rm -v /home/silverwulf/comfy-stack/stock-gallery:/app -w /app node:22-alpine node --check server.mjs
docker run --rm -v /home/silverwulf/comfy-stack/comfy-mcp:/app -w /app node:22-alpine node --check server.mjs

# Rebuild stock-gallery image
cd /home/silverwulf/comfy-stack/stock-gallery && docker build -t stock-gallery:latest .

# Rebuild comfy-mcp image
cd /home/silverwulf/comfy-stack/comfy-mcp && docker build -t comfy-mcp:latest .

# Recreate the long-running stock-gallery container (preserves all bind mounts and Traefik labels)
docker rm -f stock-gallery
docker run -d --name stock-gallery --restart unless-stopped --network ollamawulf \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /home/silverwulf/comfy-stack/gallery:/gallery \
  -v /home/silverwulf/comfy-stack/workflows:/workflows:ro \
  -v /home/silverwulf/comfy-stack/state:/state \
  -l traefik.enable=true \
  -l "traefik.http.routers.stock-http.entrypoints=http" \
  -l "traefik.http.routers.stock-http.rule=Host(\`stock.silverwulf.com\`)" \
  -l "traefik.http.routers.stock.entrypoints=https" \
  -l "traefik.http.routers.stock.rule=Host(\`stock.silverwulf.com\`)" \
  -l "traefik.http.routers.stock.tls=true" \
  -l "traefik.http.routers.stock.tls.certresolver=letsencrypt" \
  -l "traefik.http.services.stock.loadbalancer.server.port=80" \
  stock-gallery:latest
```

`comfy-mcp` is **not run as a daemon**. It's invoked per-tool-call by Claude Code via `claude mcp add-json --scope user comfy-mcp ...` — the registration lives in `~/.claude.json` and spawns `docker run -i --rm` on demand. There is no container to recreate; rebuilding the image is enough, and the next MCP tool call picks it up.

## Testing

There are **no unit tests on disk**. Testing is a runbook of curl + docker commands documented in the plan file at `/home/silverwulf/.claude/plans/mellow-prancing-boole.md`. The most useful commands:

```bash
# Smoke a gen end to end
curl -s -X POST -H "content-type: application/json" -H "Host: stock.silverwulf.com" \
  -d '{"prompt":"a cat","style":"photo","orientation":"square","variations":1}' \
  http://localhost/api/generate

# Watch the queue
curl -s -H "Host: stock.silverwulf.com" http://localhost/api/queue | python3 -m json.tool

# Bayou regression (ensures the Ollama cycle didn't break the other tenant)
curl -s -X POST https://bayou.silverwulf.work/api/chat \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}' --max-time 30

# Inspect sidecars
ls -t /home/silverwulf/comfy-stack/gallery/*.json | head -3 | xargs cat

# Lock state
cat /home/silverwulf/comfy-stack/state/comfy-gpu.lock 2>&1 || echo "(absent — system idle)"

# Redis state
docker exec onyx-cache redis-cli KEYS "stockgal:*"
```

## Public path

**Not Traefik LE**. Let's Encrypt's TLS-ALPN-01 challenge fails against the bare home IP (`tls: unrecognized name`), so `stock.silverwulf.com` routes through Cloudflare Tunnel instead. Config: `~/.cloudflared/config.yml` ingress for `stock.silverwulf.com → http://localhost:80`. Systemd user service: `cloudflared.service`. The Traefik labels above still get the request from CF tunnel → coolify-proxy → stock-gallery container by Host header; only the TLS termination happens at Cloudflare's edge.

## Things to NOT do

- Don't add a second cache (use `onyx-cache` Redis with `stockgal:*` prefix).
- Don't add a database (sidecars on disk + Redis cache is the data model).
- Don't add Tailwind / a frontend framework (the editorial dark archive aesthetic is intentional and hand-rolled in `renderIndex`).
- Don't change the lock owner format without updating both `stock-gallery::recoverStaleLock` and `comfy-mcp::acquireLock`.
- Don't put user-controlled values in Redis keys.
- Don't rebuild ComfyUI from scratch — the `yanwk/comfyui-boot:cu124-slim` base needs a `pre-start.sh` hook that `pip install`s `comfy_aimdo` (the upstream image forgets to). The hook lives in the `comfyui_data` named volume; if you ever recreate that volume, re-add it before starting the container.
- Don't use `qwen_3_4b_fp8_mixed.safetensors` for the text encoder — it errors out with `AttributeError: 'NoneType' object has no attribute 'Params'` in this ComfyUI version. Use the bf16 variant.

## Where to read first when you join this codebase

1. `README.md` — high-level diagram and GPU coordination story
2. This file (`CLAUDE.md`) — operational + architectural details
3. `/home/silverwulf/.claude/plans/mellow-prancing-boole.md` — full v1 + v2 + v3 plan history, code review, and four sweep reports. The "context compaction" section near the bottom is a single-paragraph state-of-the-world.
4. `stock-gallery/server.mjs::processJob` — the heart of the gen pipeline, ~80 lines that touch every subsystem
5. `stock-gallery/server.mjs::renderIndex` — the dynamic HTML build, including the embedded JS for the lightbox/queue/compose UI
