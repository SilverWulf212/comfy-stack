#!/usr/bin/env node
// comfy-mcp — MCP stdio server exposing generate_image to Claude Code.
//
// Tool: generate_image(prompt, [negative_prompt, style, width, height, steps, seed])
// Pipeline:
//   1. acquire file lock (prevents concurrent jobs and watchdog races)
//   2. stop ollama containers via docker socket
//   3. POST workflow to comfyui:8188/prompt with parameter substitution
//   4. poll /history/{id} until complete
//   5. fetch PNG from /view, hash it
//   6. upload to MinIO bucket "generated-images"
//   7. start ollama containers + warm models
//   8. release lock
//   9. return https://images.silverwulf.work/<hash>.png
//
// Always restarts Ollama in finally{}, even on error.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Docker from "dockerode";
import sharp from "sharp";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

// ---------- Config ----------
const COMFY_URL       = process.env.COMFY_URL       || "http://comfyui:8188";
const GALLERY_DIR     = process.env.GALLERY_DIR     || "/gallery";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://stock.silverwulf.com";
const WORKFLOWS_DIR   = process.env.WORKFLOWS_DIR   || "/workflows";
const LOCK_FILE       = process.env.LOCK_FILE       || "/state/comfy-gpu.lock";
const LOG_FILE        = process.env.LOG_FILE        || "/state/comfy-mcp.log";
const OLLAMA_CONTAINERS = (process.env.OLLAMA_CONTAINERS || "ollama").split(",").map(s => s.trim()).filter(Boolean);
const OLLAMA_WARM_MODELS = (process.env.OLLAMA_WARM_MODELS || "qwen3.5:9b,qwen3.5:4b,nomic-embed-text").split(",").map(s => s.trim()).filter(Boolean);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 5 * 60 * 1000;

// ---------- Utilities ----------
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { await mkdir(path.dirname(LOG_FILE), { recursive: true }); await writeFile(LOG_FILE, line, { flag: "a" }); } catch {}
}

async function acquireLock() {
  await mkdir(path.dirname(LOCK_FILE), { recursive: true });
  for (let i = 0; i < 60; i++) {
    if (!existsSync(LOCK_FILE)) {
      await writeFile(LOCK_FILE, `${process.pid} ${new Date().toISOString()}`);
      return;
    }
    await sleep(1000);
  }
  throw new Error("Could not acquire GPU lock after 60s — another job may be stuck. Check " + LOCK_FILE);
}
async function releaseLock() {
  try { await unlink(LOCK_FILE); } catch {}
}

async function stopOllama() {
  for (const name of OLLAMA_CONTAINERS) {
    try {
      const c = docker.getContainer(name);
      const info = await c.inspect();
      if (info.State.Running) {
        await log(`stopping ${name}...`);
        await c.stop({ t: 10 });
      }
    } catch (e) {
      await log(`stopOllama(${name}) ignored: ${e.message}`);
    }
  }
  // Give VRAM a moment to clear
  await sleep(2000);
}

async function startOllama() {
  for (const name of OLLAMA_CONTAINERS) {
    try {
      const c = docker.getContainer(name);
      const info = await c.inspect();
      if (!info.State.Running) {
        await log(`starting ${name}...`);
        await c.start();
      }
    } catch (e) {
      await log(`startOllama(${name}) failed: ${e.message}`);
    }
  }
  // Wait for API to come up, then warm models with 1-token generations
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`);
      if (r.ok) break;
    } catch {}
    await sleep(1000);
  }
  for (const m of OLLAMA_WARM_MODELS) {
    try {
      await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, prompt: "hi", stream: false, options: { num_predict: 1 } }),
      });
      await log(`warmed ${m}`);
    } catch (e) {
      await log(`warm ${m} failed: ${e.message}`);
    }
  }
}

function deepReplace(node, vars) {
  if (typeof node === "string") {
    if (/^\{\{(\w+)\}\}$/.test(node)) {
      const k = node.match(/^\{\{(\w+)\}\}$/)[1];
      return vars[k] !== undefined ? vars[k] : node;
    }
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`));
  }
  if (Array.isArray(node)) return node.map(n => deepReplace(n, vars));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "_meta") continue; // strip our meta block before sending to ComfyUI
      out[k] = deepReplace(v, vars);
    }
    return out;
  }
  return node;
}

async function loadWorkflow(style) {
  const filename = `${style}.json`;
  const filepath = path.join(WORKFLOWS_DIR, filename);
  if (!existsSync(filepath)) {
    throw new Error(`Unknown style "${style}". Workflow not found at ${filepath}`);
  }
  const raw = await readFile(filepath, "utf8");
  return JSON.parse(raw);
}

async function comfyQueue(prompt) {
  const r = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, client_id: "comfy-mcp" }),
  });
  if (!r.ok) throw new Error(`ComfyUI /prompt ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.prompt_id) throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(j)}`);
  return j.prompt_id;
}

async function comfyWaitAndGetImage(promptId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const r = await fetch(`${COMFY_URL}/history/${promptId}`);
    if (r.ok) {
      const h = await r.json();
      const entry = h[promptId];
      if (entry) {
        if (entry.status?.status_str === "error") {
          throw new Error(`ComfyUI job error: ${JSON.stringify(entry.status?.messages || entry.status)}`);
        }
        const outputs = entry.outputs || {};
        for (const node of Object.values(outputs)) {
          if (node.images?.length) {
            const img = node.images[0];
            const url = `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&type=${img.type || "output"}&subfolder=${encodeURIComponent(img.subfolder || "")}`;
            const ir = await fetch(url);
            if (!ir.ok) throw new Error(`ComfyUI /view ${ir.status}`);
            const buf = Buffer.from(await ir.arrayBuffer());
            return { buf, filename: img.filename };
          }
        }
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`ComfyUI job timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ---------- Gallery storage ----------
// stock-gallery serves the index dynamically, so we only need to drop the file.
async function saveToGallery(buf, key) {
  await mkdir(GALLERY_DIR, { recursive: true });
  const tmp = path.join(GALLERY_DIR, `.${key}.tmp`);
  const final = path.join(GALLERY_DIR, key);
  await writeFile(tmp, buf);
  await rename(tmp, final);
}

// Sidecar JSON next to the image (Gap 8 — symmetric with stock-gallery)
async function writeSidecar(filename, meta) {
  const base = filename.replace(/\.[^.]+$/, "");
  const final = path.join(GALLERY_DIR, `${base}.json`);
  const tmp = path.join(GALLERY_DIR, `.${base}.json.tmp`);
  await writeFile(tmp, JSON.stringify(meta, null, 2));
  await rename(tmp, final);
}

// Orientation presets for the MCP tool
const ORIENTATIONS = {
  square:    { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768  },
  portrait:  { width: 768,  height: 1344 },
};

// ---------- Main pipeline ----------
async function generateImage(args) {
  const {
    prompt,
    negative_prompt = "blurry, ugly, bad",
    workflow_name = "zimage-default",
    style = "raw",            // metadata only — comfy-mcp does NOT call the LLM rewriter
    orientation,              // optional: if set, overrides width/height
    width: explicitWidth,
    height: explicitHeight,
    steps = 9,
    cfg = 1.0,
    seed = randomInt(0, 2 ** 31 - 1),
  } = args;

  if (!prompt || typeof prompt !== "string") {
    throw new Error("prompt is required (non-empty string)");
  }

  // Resolve dimensions: orientation preset wins over explicit width/height
  let width = 1024, height = 1024;
  if (orientation && ORIENTATIONS[orientation]) {
    width = ORIENTATIONS[orientation].width;
    height = ORIENTATIONS[orientation].height;
  } else if (explicitWidth || explicitHeight) {
    width = Number(explicitWidth) || 1024;
    height = Number(explicitHeight) || 1024;
  }
  const effectiveOrient = orientation
    || (width === height ? "square" : width > height ? "landscape" : "portrait");

  await acquireLock();
  let url = null;
  try {
    await stopOllama();

    // Wait for ComfyUI to be reachable
    let comfyReady = false;
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch(`${COMFY_URL}/system_stats`);
        if (r.ok) { comfyReady = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!comfyReady) throw new Error(`ComfyUI not reachable at ${COMFY_URL}`);

    const workflowTemplate = await loadWorkflow(workflow_name);
    const workflow = deepReplace(workflowTemplate, {
      prompt, negative_prompt,
      seed: Number(seed),
      steps: Number(steps),
      cfg: Number(cfg),
      width: Number(width),
      height: Number(height),
    });

    await log(`queueing workflow=${workflow_name} style=${style} ${width}x${height} seed=${seed}`);
    const promptId = await comfyQueue(workflow);
    await log(`prompt_id=${promptId}, polling...`);
    const { buf: rawPng } = await comfyWaitAndGetImage(promptId);
    await log(`got image ${rawPng.length} bytes (raw png)`);

    // Sharp post-process: gentle sharpen + WebP q90, web-ready by default
    const webpBuf = await sharp(rawPng)
      .sharpen({ sigma: 0.6 })
      .webp({ quality: 90, effort: 5 })
      .toBuffer();
    await log(`encoded webp ${webpBuf.length} bytes (${Math.round(100 - 100 * webpBuf.length / rawPng.length)}% smaller)`);

    const hash = createHash("sha256").update(webpBuf).digest("hex").slice(0, 16);
    const key = `${hash}.webp`;
    await saveToGallery(webpBuf, key);
    await writeSidecar(key, {
      prompt,
      enhancedPrompt: prompt,    // comfy-mcp doesn't run the LLM rewriter
      enhanceFailed: false,
      style,
      tags: [],                  // comfy-mcp path leaves tags empty (no LLM extraction here)
      orientation: effectiveOrient,
      width,
      height,
      steps,
      cfg,
      seed,
      model: "z-image-turbo Q5_K_M",
      createdAt: new Date().toISOString(),
      source: "comfy-mcp",
    });
    url = `${PUBLIC_BASE_URL}/${key}`;
    await log(`saved -> ${url}`);
  } finally {
    await startOllama();
    await releaseLock();
  }

  return { url, prompt, style, orientation: effectiveOrient, width, height, steps, seed };
}

// ---------- MCP server boilerplate ----------
const server = new Server(
  { name: "comfy-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate an image from a text prompt using Z-Image Turbo on the local RTX 4060. " +
        "Stops local Ollama for the duration of the job, runs the workflow in ComfyUI, " +
        "saves to the shared gallery folder with a sidecar metadata JSON, and returns a public URL " +
        "at https://stock.silverwulf.com/<hash>.png. Takes ~10-30s per image.",
      inputSchema: {
        type: "object",
        properties: {
          prompt:          { type: "string", description: "Text prompt describing the image" },
          negative_prompt: { type: "string", description: "Things to avoid (default: 'blurry, ugly, bad')" },
          style:           { type: "string", enum: ["raw", "photo", "editorial", "cinematic", "illustration", "product"], description: "Style label stored in metadata sidecar (does NOT trigger LLM rewrite — that's only available via the stock-gallery web UI). Default: raw." },
          orientation:     { type: "string", enum: ["square", "landscape", "portrait"], description: "Orientation preset. square=1024², landscape=1344x768 (16:9), portrait=768x1344 (9:16). Overrides explicit width/height. Default: square." },
          workflow_name:   { type: "string", description: "Workflow JSON file under /workflows (default: zimage-default). Use this to swap to a different model entirely." },
          width:           { type: "integer", description: "Width in px (default 1024, multiple of 64). Ignored if orientation is set." },
          height:          { type: "integer", description: "Height in px (default 1024, multiple of 64). Ignored if orientation is set." },
          steps:           { type: "integer", description: "Sampling steps (default 9, range 6-12)" },
          cfg:             { type: "number",  description: "Classifier-free guidance (default 1.0; turbo models use ~1)" },
          seed:            { type: "integer", description: "RNG seed (default: random)" },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== "generate_image") {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = await generateImage(args || {});
    return {
      content: [
        { type: "text", text: `Image generated:\n${result.url}\n\nseed=${result.seed} steps=${result.steps} ${result.width}x${result.height}` },
      ],
    };
  } catch (e) {
    await log(`ERROR: ${e.stack || e.message}`);
    return {
      isError: true,
      content: [{ type: "text", text: `generate_image failed: ${e.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
await log("comfy-mcp server started");
