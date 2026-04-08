#!/usr/bin/env node
// stock-gallery — dynamic image gallery + batch upscale/download API.
//
// Routes:
//   GET  /                    → dynamic HTML grid (newest first)
//   GET  /<file>              → static image bytes (.png/.webp)
//   POST /api/upscale         {files:[...]} → start a batch upscale job
//   GET  /api/upscale/status  → current job state
//   POST /api/download-zip    {files:[...]} → stream a ZIP back
//
// Upscale pipeline per file:
//   1. acquire /state/comfy-gpu.lock (shared with comfy-mcp; serializes GPU)
//   2. docker stop ollama
//   3. multipart-upload the source PNG to comfyui:8188/upload/image
//   4. POST workflows/upscale.json (with substitution) to /prompt
//   5. poll /history/<id>; fetch the 4096x4096 PNG from /view
//   6. sharp pipeline: sharpen → resize 2048 → webp q90
//   7. atomic-write gallery/<hash>.webp; unlink original gallery/<hash>.png
//   8. on last file in batch: docker start ollama + warm models
//   9. release lock

import http from "node:http";
import { readFile, writeFile, rename, unlink, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import Docker from "dockerode";
import archiver from "archiver";
import Redis from "ioredis";

// ---------- Config ----------
const PORT            = Number(process.env.PORT || 80);
const GALLERY_DIR     = process.env.GALLERY_DIR     || "/gallery";
const WORKFLOWS_DIR   = process.env.WORKFLOWS_DIR   || "/workflows";
const COMFY_URL       = process.env.COMFY_URL       || "http://comfyui:8188";
const LOCK_FILE       = process.env.LOCK_FILE       || "/state/comfy-gpu.lock";
const LOG_FILE        = process.env.LOG_FILE        || "/state/stock-gallery.log";
const OLLAMA_CONTAINERS = (process.env.OLLAMA_CONTAINERS || "ollama").split(",").map(s => s.trim()).filter(Boolean);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const WARM_GEN_MODELS   = (process.env.WARM_GEN_MODELS   || "qwen3.5:9b,qwen3.5:4b").split(",").map(s => s.trim()).filter(Boolean);
const WARM_EMBED_MODELS = (process.env.WARM_EMBED_MODELS || "nomic-embed-text").split(",").map(s => s.trim()).filter(Boolean);
const ENHANCE_MODEL   = process.env.ENHANCE_MODEL || "qwen3.5:4b";
const REDIS_URL       = process.env.REDIS_URL || "redis://onyx-cache:6379";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS  = 5 * 60 * 1000;
const MAX_QUEUE        = 16;
const MAX_PROMPT_LEN   = 1000;
const ENHANCE_TIMEOUT_MS = 30_000;
const TAGS_TIMEOUT_MS    = 20_000;
const PAGE_SIZE          = 50;
const CACHE_TTL_SECONDS  = 300; // 5 min for sidecars + tag index
const CACHE_HTML_TTL     = 60;  // 1 min for rendered HTML pages

// ---------- Styles ----------
// NOTE: the {{prompt}} placeholder here is consumed by enhancePrompt(), NOT by deepReplace().
// They operate on different layers (string templating vs ComfyUI workflow JSON) and never collide.
const STYLES = {
  raw: {
    label: "raw",
    description: "no rewrite — your prompt verbatim",
    template: null,
  },
  photo: {
    label: "photo",
    description: "photorealistic, natural lighting, lens-aware",
    template: `You are a prompt engineer for an AI image model. Rewrite the user's image prompt to enforce a photorealistic style: natural lighting, shallow depth of field, lens-aware composition, real-world materials and shadows. Keep the subject and composition intact — do not add or remove subjects. Output ONLY the rewritten prompt. No quotes, no preamble, no explanation.

User prompt: {{prompt}}`,
  },
  editorial: {
    label: "editorial",
    description: "high-end magazine, dramatic composition",
    template: `You are a prompt engineer for an AI image model. Rewrite the user's image prompt to enforce a high-end editorial magazine aesthetic: dramatic composition, sophisticated color grading, considered framing, subject-forward. Keep the subject intact — do not add or remove subjects. Output ONLY the rewritten prompt. No quotes, no preamble, no explanation.

User prompt: {{prompt}}`,
  },
  cinematic: {
    label: "cinematic",
    description: "film still, anamorphic, atmospheric",
    template: `You are a prompt engineer for an AI image model. Rewrite the user's image prompt to enforce a cinematic film-still aesthetic: anamorphic framing, atmospheric lighting, color graded for emotional tone, slight film grain. Keep the subject intact — do not add or remove subjects. Output ONLY the rewritten prompt. No quotes, no preamble, no explanation.

User prompt: {{prompt}}`,
  },
  illustration: {
    label: "illustration",
    description: "digital painting, expressive brushwork",
    template: `You are a prompt engineer for an AI image model. Rewrite the user's image prompt to enforce a digital illustration style: expressive brushwork, rich color palette, painterly textures, considered light direction. Keep the subject intact — do not add or remove subjects. Output ONLY the rewritten prompt. No quotes, no preamble, no explanation.

User prompt: {{prompt}}`,
  },
  product: {
    label: "product",
    description: "studio product shot, soft seamless background",
    template: `You are a prompt engineer for an AI image model. Rewrite the user's image prompt to enforce a studio product photography style: soft seamless background, even diffuse lighting, accurate materials and textures, subject-centered. Keep the subject intact — do not add or remove subjects. Output ONLY the rewritten prompt. No quotes, no preamble, no explanation.

User prompt: {{prompt}}`,
  },
};

// ---------- Orientations ----------
const ORIENTATIONS = {
  square:    { label: "square",    width: 1024, height: 1024 },
  landscape: { label: "landscape", width: 1344, height: 768  },  // 16:9-ish, multiples of 64
  portrait:  { label: "portrait",  width: 768,  height: 1344 },
};

// ---------- Utilities ----------
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// ---------- Redis cache (graceful degradation when down) ----------
// Reuses the existing onyx-cache container shared with Bayou. Keys are namespaced
// under stockgal:* so we don't collide with Bayou's keys.
const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // give up immediately if redis is down
});
let redisOk = false;
redis.connect()
  .then(() => { redisOk = true; log("redis connected"); })
  .catch(e => log(`redis connect failed: ${e.message}; running uncached`));
redis.on("error", e => { /* swallow — already logged at connect; runtime errors handled inline */ });
redis.on("ready", () => { redisOk = true; });
redis.on("end",   () => { redisOk = false; });

async function cached(key, ttl, fn) {
  if (!redisOk) return fn();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const fresh = await fn();
  try { await redis.set(key, JSON.stringify(fresh), "EX", ttl); } catch {}
  return fresh;
}

async function invalidateCache() {
  if (!redisOk) return;
  try {
    await redis.del("stockgal:sidecars", "stockgal:tagindex");
    // Wildcard delete the rendered HTML pages via SCAN
    const stream = redis.scanStream({ match: "stockgal:html:*", count: 100 });
    const keys = [];
    for await (const batch of stream) keys.push(...batch);
    if (keys.length) await redis.del(...keys);
  } catch (e) { await log(`invalidateCache failed: ${e.message}`); }
}

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { await mkdir(path.dirname(LOG_FILE), { recursive: true }); await writeFile(LOG_FILE, line, { flag: "a" }); } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeFilename(name) {
  // Only allow files matching <hex>.<ext> with no path components
  return /^[a-f0-9]{8,64}\.(png|jpe?g|webp)$/i.test(name);
}

async function listGallery() {
  const entries = (await readdir(GALLERY_DIR).catch(() => []))
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith("."));
  const stats = await Promise.all(entries.map(async f => {
    const s = await stat(path.join(GALLERY_DIR, f));
    return { name: f, mtime: s.mtimeMs, size: s.size };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats;
}

// ---------- Lock + Ollama coordination ----------
async function acquireLock() {
  await mkdir(path.dirname(LOCK_FILE), { recursive: true });
  for (let i = 0; i < 120; i++) {
    if (!existsSync(LOCK_FILE)) {
      await writeFile(LOCK_FILE, `${process.pid} stock-gallery ${new Date().toISOString()}`);
      return;
    }
    await sleep(1000);
  }
  throw new Error("Could not acquire GPU lock after 120s");
}
async function releaseLock() {
  try { await unlink(LOCK_FILE); } catch {}
}

async function stopOllama() {
  for (const name of OLLAMA_CONTAINERS) {
    try {
      const c = docker.getContainer(name);
      const info = await c.inspect();
      if (info.State.Running) { await log(`stopping ${name}...`); await c.stop({ t: 10 }); }
    } catch (e) { await log(`stopOllama(${name}) ignored: ${e.message}`); }
  }
  await sleep(2000);
}

async function startOllama() {
  for (const name of OLLAMA_CONTAINERS) {
    try {
      const c = docker.getContainer(name);
      const info = await c.inspect();
      if (!info.State.Running) { await log(`starting ${name}...`); await c.start(); }
    } catch (e) { await log(`startOllama(${name}) failed: ${e.message}`); }
  }
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${OLLAMA_URL}/api/tags`); if (r.ok) break; } catch {}
    await sleep(1000);
  }
  for (const m of WARM_GEN_MODELS) {
    try {
      await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, prompt: "hi", stream: false, options: { num_predict: 1 } }),
      });
      await log(`warmed ${m}`);
    } catch (e) { await log(`warm ${m} failed: ${e.message}`); }
  }
  for (const m of WARM_EMBED_MODELS) {
    try {
      await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, prompt: "hi" }),
      });
      await log(`warmed ${m} (embed)`);
    } catch (e) { await log(`warm ${m} (embed) failed: ${e.message}`); }
  }
}

// ---------- ComfyUI workflow helpers ----------
// IMPORTANT: if the entire string is a single placeholder (e.g. "{{width}}"),
// return the raw value (preserves Number type for EmptySD3LatentImage et al).
// Otherwise interpolate as a string. comfy-mcp uses an identical impl.
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
      if (k === "_meta") continue;
      out[k] = deepReplace(v, vars);
    }
    return out;
  }
  return node;
}

// ---------- LLM enhancement ----------
// Strip common LLM output cruft: <think> blocks (for reasoning models),
// surrounding quotes, "Here is..." preambles, markdown fences, multi-paragraph drift.
function cleanLlmOutput(s) {
  if (typeof s !== "string") return "";
  let out = s;
  // Strip <think>...</think> blocks (qwen3.5 reasoning model output)
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Strip orphaned think tags if the closing tag is missing
  out = out.replace(/<\/?think>/gi, "");
  out = out.trim();
  // Strip code fences
  out = out.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  // Drop common preambles
  out = out.replace(/^(here(?:'s| is)?\s+(?:the\s+)?(?:rewritten|new|updated|enhanced|improved)?\s*prompt[:\-]?\s*)/i, "");
  out = out.replace(/^(rewritten\s+prompt[:\-]?\s*)/i, "");
  // Take first paragraph
  out = out.split(/\n{2,}/)[0];
  // Strip surrounding quotes (single, double, smart)
  out = out.trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").trim();
  // Cap length
  if (out.length > 1500) out = out.slice(0, 1500);
  return out;
}

async function enhancePrompt(rawPrompt, styleKey) {
  const style = STYLES[styleKey];
  if (!style || !style.template) return { text: rawPrompt, enhanced: false };
  const filled = style.template.replace(/\{\{prompt\}\}/g, rawPrompt);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: ENHANCE_MODEL,
        prompt: filled,
        stream: false,
        think: false,            // qwen3.5 reasoning models — disable thinking tokens
        keep_alive: "5m",
        options: { temperature: 0.4, num_predict: 400 },
      }),
      signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const cleaned = cleanLlmOutput(j.response || "");
    if (!cleaned) throw new Error("empty after cleanup");
    return { text: cleaned, enhanced: true };
  } catch (e) {
    await log(`enhancePrompt(${styleKey}) failed, falling back to raw: ${e.message}`);
    return { text: rawPrompt, enhanced: false, enhanceError: e.message };
  }
}

// ---------- Hashtag extraction ----------
// Lowercase, alphanumerics + hyphens, must start with a letter, ≤30 chars
function slugifyTag(s) {
  const t = String(s || "").toLowerCase().trim()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]{0,29}$/.test(t) ? t : "";
}

async function extractTags(rawPrompt, enhancedPrompt) {
  const promptForTags = enhancedPrompt || rawPrompt;
  const text = `Extract 1-5 short lowercase tags describing the main visual subjects of this image prompt. Output ONLY a comma-separated list. No '#', no quotes, no explanation. Each tag is one word or hyphenated, max 20 characters.

Examples:
- "a calico cat on a sunlit windowsill" → cat, windowsill, sunlight
- "a vintage brass telescope on an oak desk" → telescope, brass, desk

Prompt: ${promptForTags}`;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: ENHANCE_MODEL,
        prompt: text,
        stream: false,
        think: false,
        keep_alive: "5m",
        options: { temperature: 0.2, num_predict: 80 },
      }),
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const cleaned = cleanLlmOutput(j.response || "");
    const seen = new Set();
    const tags = [];
    for (const raw of cleaned.split(/[,\n]/)) {
      const t = slugifyTag(raw);
      if (t && !seen.has(t)) { seen.add(t); tags.push(t); if (tags.length >= 5) break; }
    }
    return tags;
  } catch (e) {
    await log(`extractTags failed: ${e.message}`);
    return [];
  }
}

// ---------- Pagination + filter ----------
const UNTAGGED_TOKEN = "__untagged__";
function paginateAndFilter(items, sidecars, { page, tag }) {
  const filtered = !tag
    ? items
    : tag === UNTAGGED_TOKEN
      ? items.filter(it => !(sidecars[it.name]?.tags?.length))
      : items.filter(it => (sidecars[it.name]?.tags || []).includes(tag));
  const totalCount = items.length;
  const filteredCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));
  const p = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (p - 1) * PAGE_SIZE;
  return {
    pageItems: filtered.slice(start, start + PAGE_SIZE),
    page: p, totalPages, totalCount, filteredCount, tag: tag || null,
  };
}

function buildTagIndex(items, sidecars) {
  const counts = new Map();
  let untagged = 0;
  for (const it of items) {
    const meta = sidecars[it.name];
    const tags = (meta?.tags || []).filter(t => typeof t === "string");
    if (tags.length === 0) { untagged++; continue; }
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return {
    tags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count })),
    untagged,
    total: items.length,
  };
}

// ---------- Sidecar JSON ----------
function basenameNoExt(name) {
  return name.replace(/\.[^.]+$/, "");
}

async function writeSidecar(filename, meta) {
  const base = basenameNoExt(filename);
  const final = path.join(GALLERY_DIR, `${base}.json`);
  const tmp = path.join(GALLERY_DIR, `.${base}.json.tmp`);
  await writeFile(tmp, JSON.stringify(meta, null, 2));
  await rename(tmp, final);
}

async function readSidecar(filename) {
  try {
    const fp = path.join(GALLERY_DIR, `${basenameNoExt(filename)}.json`);
    const raw = await readFile(fp, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readAllSidecars(items) {
  const out = {};
  await Promise.all(items.map(async it => {
    const meta = await readSidecar(it.name);
    if (meta) out[it.name] = meta;
  }));
  return out;
}

async function loadWorkflow(name) {
  const fp = path.join(WORKFLOWS_DIR, `${name}.json`);
  return JSON.parse(await readFile(fp, "utf8"));
}

async function comfyUploadImage(filename, buf) {
  // ComfyUI's /upload/image accepts multipart/form-data
  const boundary = "----comfymcp" + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`${COMFY_URL}/upload/image`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length },
    body,
  });
  if (!r.ok) throw new Error(`ComfyUI /upload/image ${r.status}: ${await r.text()}`);
  return r.json();
}

async function comfyQueue(prompt) {
  const r = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, client_id: "stock-gallery" }),
  });
  if (!r.ok) throw new Error(`ComfyUI /prompt ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.prompt_id) throw new Error(`No prompt_id: ${JSON.stringify(j)}`);
  return j.prompt_id;
}

async function comfyWaitImage(promptId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const r = await fetch(`${COMFY_URL}/history/${promptId}`);
    if (r.ok) {
      const h = await r.json();
      const entry = h[promptId];
      if (entry) {
        if (entry.status?.status_str === "error") throw new Error(`ComfyUI error: ${JSON.stringify(entry.status?.messages || entry.status)}`);
        for (const node of Object.values(entry.outputs || {})) {
          if (node.images?.length) {
            const img = node.images[0];
            const url = `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&type=${img.type || "output"}&subfolder=${encodeURIComponent(img.subfolder || "")}`;
            const ir = await fetch(url);
            if (!ir.ok) throw new Error(`/view ${ir.status}`);
            return Buffer.from(await ir.arrayBuffer());
          }
        }
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("ComfyUI job timed out");
}

// ---------- Upscale orchestration ----------
async function upscaleOne(filename) {
  const inPath = path.join(GALLERY_DIR, filename);
  if (!existsSync(inPath)) throw new Error(`not found: ${filename}`);
  const buf = await readFile(inPath);

  await comfyUploadImage(filename, buf);
  const wf = deepReplace(await loadWorkflow("upscale"), { input_image: filename });
  const promptId = await comfyQueue(wf);
  const upscaledPng = await comfyWaitImage(promptId);

  // Sharp pipeline: gentle sharpen at full 4x → resize to 2x (acts as supersampling) → webp q90
  const webpBuf = await sharp(upscaledPng)
    .sharpen({ sigma: 0.8 })
    .resize(2048, 2048, { fit: "inside", kernel: "lanczos3" })
    .webp({ quality: 90, effort: 5 })
    .toBuffer();

  // hash prefix is from the original filename: <hash>.png → <hash>.webp
  const base = filename.replace(/\.[^.]+$/, "");
  const outName = `${base}.webp`;
  const outPath = path.join(GALLERY_DIR, outName);
  const tmpPath = path.join(GALLERY_DIR, `.${outName}.tmp`);
  await writeFile(tmpPath, webpBuf);
  await rename(tmpPath, outPath);

  // Replace original (D)
  if (filename !== outName) {
    try { await unlink(inPath); } catch {}
  }
  // Invalidate the cached thumbnail — old one was generated from the pre-upscale source
  try {
    const base = filename.replace(/\.[^.]+$/, "");
    await unlink(path.join(GALLERY_DIR, ".thumbs", `${base}.webp`));
  } catch {}
  return { input: filename, output: outName, bytes: webpBuf.length };
}

// ---------- Thumbnail subsystem ----------
const THUMBS_DIR = path.join(GALLERY_DIR, ".thumbs");
const THUMB_SIZE = 480;

async function generateThumb(sourceName) {
  const sourcePath = path.join(GALLERY_DIR, sourceName);
  if (!existsSync(sourcePath)) throw new Error(`source not found: ${sourceName}`);
  const base = sourceName.replace(/\.[^.]+$/, "");
  const outPath = path.join(THUMBS_DIR, `${base}.webp`);
  await mkdir(THUMBS_DIR, { recursive: true });
  const buf = await sharp(sourcePath)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover", position: "attention" })
    .webp({ quality: 75, effort: 4 })
    .toBuffer();
  const tmp = outPath + ".tmp";
  await writeFile(tmp, buf);
  await rename(tmp, outPath);
  return outPath;
}

// ---------- Gen orchestration ----------
async function genOne({ enhancedPrompt, width, height, seed }) {
  const wf = deepReplace(await loadWorkflow("zimage-default"), {
    prompt: enhancedPrompt,
    negative_prompt: "blurry, ugly, bad",
    seed: Number(seed),
    steps: 9,
    cfg: 1.0,
    width: Number(width),
    height: Number(height),
  });
  const promptId = await comfyQueue(wf);
  const rawPng = await comfyWaitImage(promptId);

  // WebP-by-default: gentle sharpen + WebP q90 so every gen is web-ready out of the box.
  // 1024² PNG (~1.2MB) → WebP (~250KB), 768×1344 PNG (~1.5MB) → WebP (~150KB).
  const webpBuf = await sharp(rawPng)
    .sharpen({ sigma: 0.6 })
    .webp({ quality: 90, effort: 5 })
    .toBuffer();

  // Hash the FINAL webp bytes — content-addressed by what's actually on disk
  const hash = createHashHex(webpBuf);
  const filename = `${hash}.webp`;
  await mkdir(GALLERY_DIR, { recursive: true });
  const tmp = path.join(GALLERY_DIR, `.${filename}.tmp`);
  const final = path.join(GALLERY_DIR, filename);
  await writeFile(tmp, webpBuf);
  await rename(tmp, final);
  return { filename, bytes: webpBuf.length };
}

function createHashHex(buf) {
  // 16-char sha prefix, matching the existing scheme
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

// ---------- Queue (single worker, deferred wake) ----------
const queue = [];
const finishedHistory = []; // last few completed/cancelled jobs for UI display
let runningJob = null;
let workerWake = () => {};
let workerStarted = false;

function enqueueJob(spec) {
  // Cancelled jobs still occupy queue slots until the worker shifts them out;
  // exclude them from the cap so cancellation actually frees up capacity.
  const activePending = queue.filter(j => j.state !== "cancelled").length;
  if (activePending >= MAX_QUEUE) {
    const e = new Error(`queue full (${MAX_QUEUE} pending)`);
    e.code = 429;
    throw e;
  }
  const job = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    state: "pending",
    prompt: spec.prompt,
    enhancedPrompt: null,
    enhanceFailed: false,
    style: spec.style,
    orientation: spec.orientation,
    variations: spec.variations,
    width: ORIENTATIONS[spec.orientation].width,
    height: ORIENTATIONS[spec.orientation].height,
    done: 0,
    results: [],
    errors: [],
    submittedAt: Date.now(),
  };
  queue.push(job);
  workerWake();
  return job;
}

async function recoverStaleLock() {
  // If we own a stale lock from a previous (crashed/killed) instance, clear it
  // and bring Ollama back up. The lock contents include our owner string.
  try {
    if (!existsSync(LOCK_FILE)) return;
    const contents = await readFile(LOCK_FILE, "utf8").catch(() => "");
    if (contents.includes("stock-gallery")) {
      await log(`recovering stale lock: ${contents.trim()}`);
      await unlink(LOCK_FILE).catch(() => {});
      await startOllama();
    }
  } catch (e) {
    await log(`recoverStaleLock error: ${e.message}`);
  }
}

function startWorker() {
  if (workerStarted) return;
  workerStarted = true;
  recoverStaleLock().catch(e => log(`recover error: ${e.message}`));
  (async function worker() {
    while (true) {
      if (queue.length === 0) {
        await new Promise(r => (workerWake = r));
        continue;
      }
      const job = queue.shift();
      if (job.state === "cancelled") {
        finishedHistory.unshift(job);
        finishedHistory.length = Math.min(finishedHistory.length, 10);
        continue;
      }
      runningJob = job;
      try {
        await processJob(job);
        job.state = "done";
        job.finishedAt = Date.now();
      } catch (e) {
        await log(`job ${job.id} fatal: ${e.stack || e.message}`);
        job.state = "error";
        job.fatalError = e.message;
        job.finishedAt = Date.now();
      } finally {
        runningJob = null;
        finishedHistory.unshift(job);
        finishedHistory.length = Math.min(finishedHistory.length, 10);
      }
    }
  })().catch(e => log(`worker crashed: ${e.stack || e.message}`));
}

async function processJob(job) {
  // 1. Wait for the lock to be free so Ollama is up for the enhance call
  job.state = "enhancing";
  for (let i = 0; i < 60; i++) {
    if (!existsSync(LOCK_FILE)) break;
    await sleep(1000);
  }
  // 2. Enhance prompt (may fall through to raw)
  const enhanced = await enhancePrompt(job.prompt, job.style);
  job.enhancedPrompt = enhanced.text;
  job.enhanceFailed = !enhanced.enhanced && job.style !== "raw";

  // 2b. Extract hashtags via the same LLM (best-effort, blank on failure)
  job.tags = await extractTags(job.prompt, job.enhancedPrompt);

  // 3. Acquire GPU lock, stop Ollama, run N variations sequentially
  await acquireLock();
  try {
    await stopOllama();
    job.state = "running";
    for (let i = 0; i < job.variations; i++) {
      job.currentVariation = i + 1;
      const seed = randomInt32();
      try {
        const result = await genOne({
          enhancedPrompt: job.enhancedPrompt,
          width: job.width,
          height: job.height,
          seed,
        });
        await writeSidecar(result.filename, {
          prompt: job.prompt,
          enhancedPrompt: job.enhancedPrompt,
          enhanceFailed: job.enhanceFailed,
          style: job.style,
          tags: job.tags,
          orientation: job.orientation,
          width: job.width,
          height: job.height,
          steps: 9,
          cfg: 1.0,
          seed,
          model: "z-image-turbo Q5_K_M",
          createdAt: new Date().toISOString(),
          jobId: job.id,
        });
        job.results.push({ filename: result.filename, seed });
        await log(`gen ${job.id}.${i + 1}/${job.variations} -> ${result.filename}`);
      } catch (e) {
        job.errors.push({ variation: i + 1, error: e.message });
        await log(`gen ${job.id}.${i + 1} failed: ${e.message}`);
      }
      job.done++;
    }
  } finally {
    await startOllama();
    await releaseLock();
    // Bust the cache so the next page render reflects new images + tags
    invalidateCache().catch(() => {});
  }
}

function randomInt32() {
  return Math.floor(Math.random() * 0x7fffffff);
}

// ---------- Job state (single in-memory job) ----------
let currentJob = null;
async function runUpscaleBatch(files) {
  if (currentJob && currentJob.state === "running") {
    throw new Error("a batch is already running");
  }
  currentJob = { id: Date.now(), state: "running", total: files.length, done: 0, errors: [], results: [], started: Date.now() };

  // Run async, return immediately
  (async () => {
    try {
      await acquireLock();
      try {
        await stopOllama();
        for (const f of files) {
          if (!safeFilename(f)) {
            currentJob.errors.push({ file: f, error: "invalid filename" });
            currentJob.done++;
            continue;
          }
          try {
            const r = await upscaleOne(f);
            currentJob.results.push(r);
            await log(`upscaled ${f} → ${r.output} (${(r.bytes / 1024).toFixed(0)} KB)`);
          } catch (e) {
            currentJob.errors.push({ file: f, error: e.message });
            await log(`upscale ${f} failed: ${e.message}`);
          }
          currentJob.done++;
        }
      } finally {
        await startOllama();
        await releaseLock();
        // Bust the cache — upscaled files have new mtimes and replace originals
        invalidateCache().catch(() => {});
      }
      currentJob.state = "done";
      currentJob.finished = Date.now();
    } catch (e) {
      await log(`batch failed: ${e.stack || e.message}`);
      currentJob.state = "error";
      currentJob.fatalError = e.message;
      currentJob.finished = Date.now();
    }
  })();

  return currentJob;
}

// ---------- HTML rendering ----------
// Aesthetic: editorial dark archive. Fraunces serif display + JetBrains Mono
// for technical metadata. Warm near-black with single vermillion accent.
async function renderIndex({ pageItems, page, totalPages, totalCount, filteredCount, tag, sidecars, tagIndex }) {
  const fmtTime = ms => {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${yyyy}.${mm}.${dd} · ${hh}${mi}Z`;
  };
  const fmtSize = b => b > 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${(b / 1e3).toFixed(0)}KB`;
  const fmtKind = name => name.split(".").pop().toUpperCase();
  const truncate = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;

  const items = pageItems;
  const totalBytes = items.reduce((a, s) => a + s.size, 0);
  const lastEntry = items[0];

  const tiles = items.length === 0
    ? `<div class="empty">
         <p class="empty-quote">${tag ? `"No images for #${escapeHtml(tag)}."` : `"The archive is empty."`}</p>
         <p class="empty-hint">${tag ? `<a href="/" class="empty-link">clear filter ↺</a>` : "Compose the first image with the panel above ↑"}</p>
       </div>`
    : items.map((s, i) => {
        const meta = sidecars[s.name] || null;
        const promptAttr = meta?.prompt ? ` data-prompt="${escapeHtml(meta.prompt)}"` : "";
        const enhancedAttr = meta?.enhancedPrompt ? ` data-enhanced="${escapeHtml(meta.enhancedPrompt)}"` : "";
        const styleAttr = meta?.style ? ` data-style="${escapeHtml(meta.style)}"` : "";
        const seedAttr = meta?.seed !== undefined ? ` data-seed="${meta.seed}"` : "";
        const orientAttr = meta?.orientation ? ` data-orient="${escapeHtml(meta.orientation)}"` : "";
        const tagsAttr = meta?.tags?.length ? ` data-tags="${escapeHtml(meta.tags.join(","))}"` : "";
        const promptLine = meta?.prompt
          ? `<span class="cap-prompt">${escapeHtml(truncate(meta.prompt, 80))}</span>`
          : "";
        const tagLine = meta?.tags?.length
          ? `<span class="cap-tags">${meta.tags.map(t => `#${escapeHtml(t)}`).join(" ")}</span>`
          : "";
        return `
    <figure class="tile" data-name="${escapeHtml(s.name)}"${promptAttr}${enhancedAttr}${styleAttr}${seedAttr}${orientAttr}${tagsAttr} style="--i:${i}">
      <button class="select" type="button" aria-label="select ${escapeHtml(s.name)}" aria-pressed="false"></button>
      <div class="tile-img"><img src="thumb/${escapeHtml(s.name)}" loading="lazy" alt="${escapeHtml(s.name)}"></div>
      <figcaption>
        <span class="cap-kind">${escapeHtml(fmtKind(s.name))}${meta?.style ? ` · ${escapeHtml(meta.style)}` : ""}</span>
        <span class="cap-name">${escapeHtml(s.name.replace(/\.[^.]+$/, ""))}</span>
        ${promptLine}
        ${tagLine}
        <span class="cap-meta">${fmtTime(s.mtime)} · ${fmtSize(s.size)}</span>
      </figcaption>
    </figure>`;
      }).join("");

  // Style options for the gen panel dropdown
  const styleOptions = Object.entries(STYLES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");

  // Tag filter options for the masthead dropdown
  const tagOptions = [
    `<option value="">all images (${totalCount})</option>`,
    ...(tagIndex?.tags || []).map(({ tag: t, count }) =>
      `<option value="${escapeHtml(t)}"${tag === t ? " selected" : ""}>#${escapeHtml(t)} (${count})</option>`),
    tagIndex?.untagged > 0
      ? `<option value="${UNTAGGED_TOKEN}"${tag === UNTAGGED_TOKEN ? " selected" : ""}>— untagged (${tagIndex.untagged})</option>`
      : "",
  ].join("");

  // Pagination controls — abbreviated when many pages: 1 2 [3] 4 ... 12
  const pageHref = (n) => {
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
    if (n > 1) params.set("p", String(n));
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };
  const pageNumbers = (() => {
    if (totalPages <= 7) return Array.from({length: totalPages}, (_, i) => i + 1);
    const out = new Set([1, 2, totalPages - 1, totalPages, page - 1, page, page + 1]);
    return [...out].filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  })();
  const pagination = totalPages > 1
    ? `<nav class="pagination">
        ${page > 1 ? `<a class="pg-arrow" href="${pageHref(page - 1)}">‹ prev</a>` : `<span class="pg-arrow disabled">‹ prev</span>`}
        ${pageNumbers.map((n, i) => {
          const gap = i > 0 && pageNumbers[i] - pageNumbers[i - 1] > 1 ? `<span class="pg-gap">···</span>` : "";
          return gap + (n === page
            ? `<span class="pg-num current">${String(n).padStart(2, "0")}</span>`
            : `<a class="pg-num" href="${pageHref(n)}">${String(n).padStart(2, "0")}</a>`);
        }).join("")}
        ${page < totalPages ? `<a class="pg-arrow" href="${pageHref(page + 1)}">next ›</a>` : `<span class="pg-arrow disabled">next ›</span>`}
       </nav>`
    : "";

  // SVG noise/grain for a paper-tactile background overlay
  const grain = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.42'/></svg>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STOCK · silverwulf — image archive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,300..900,0..100&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --paper:    #0e0d0b;
    --paper-2:  #14120f;
    --ink:      #f5f0e8;
    --ink-dim:  #8a8378;
    --rule:     #2a2622;
    --vermilion: #e4582d;
    --vermilion-dim: #b4441f;
    --serif: "Fraunces", "Iowan Old Style", Georgia, serif;
    --mono:  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }

  * { box-sizing: border-box; }
  ::selection { background: var(--vermilion); color: var(--paper); }

  html, body { background: var(--paper); }
  body {
    margin: 0;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 400;
    line-height: 1.5;
    padding: 0 0 120px;
    min-height: 100vh;
    position: relative;
    overflow-x: hidden;
  }
  /* Grain/paper overlay */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    background-image: url("${grain}");
    background-size: 240px 240px;
    pointer-events: none;
    mix-blend-mode: overlay;
    opacity: 0.5;
    z-index: 1;
  }
  /* Soft vignette */
  body::after {
    content: "";
    position: fixed;
    inset: 0;
    background: radial-gradient(ellipse at 50% 0%, transparent 30%, rgba(0,0,0,0.55) 100%);
    pointer-events: none;
    z-index: 1;
  }
  main, header, footer { position: relative; z-index: 2; }

  /* ─── Masthead ────────────────────────────────────────────────────── */
  header {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: 32px;
    padding: 48px 40px 24px;
    border-bottom: 1px solid var(--rule);
  }
  @media (max-width: 720px) {
    header { grid-template-columns: 1fr; padding: 32px 20px 18px; gap: 14px; }
  }
  .mast {
    font-family: var(--serif);
    font-variation-settings: "opsz" 144, "SOFT" 30;
    font-size: clamp(56px, 11vw, 148px);
    font-weight: 380;
    font-style: normal;
    line-height: 0.85;
    letter-spacing: -0.04em;
    color: var(--ink);
    margin: 0;
    text-transform: lowercase;
  }
  .mast em {
    font-style: italic;
    font-weight: 280;
    color: var(--vermilion);
    font-variation-settings: "opsz" 144, "SOFT" 100;
  }
  .mast-sub {
    display: block;
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 400;
    line-height: 1.7;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
    max-width: 460px;
  }
  .meta-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-dim);
  }
  @media (max-width: 720px) { .meta-col { align-items: flex-start; } }
  .meta-col .num { font-size: 13px; color: var(--ink); letter-spacing: 0.05em; }
  .meta-col .bar-count-label { color: var(--vermilion); }

  /* ─── Sub-rule with running info ──────────────────────────────────── */
  .running {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    padding: 14px 40px;
    border-bottom: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--ink-dim);
  }
  @media (max-width: 720px) {
    .running { grid-template-columns: 1fr 1fr; padding: 12px 20px; gap: 8px; }
  }
  .running > div { padding-right: 16px; }
  .running .label { color: #5d574d; display: block; font-size: 9px; margin-bottom: 2px; }
  .running .val { color: var(--ink); }

  .filter-cell { display: flex; flex-direction: column; gap: 4px; }
  .tag-select-wrap { max-width: 200px; }
  .tag-select-wrap select {
    width: 100%;
    appearance: none;
    background: var(--paper);
    border: 1px solid var(--rule);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 10px;
    padding: 6px 24px 6px 8px;
    cursor: pointer;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    outline: none;
  }
  .tag-select-wrap select:hover { border-color: var(--vermilion); }

  .hdr-queue { color: var(--vermilion); font-weight: 500; }
  .of-total { color: var(--vermilion); font-size: 9px; }

  /* ─── Compose panel ─────────────────────────────────────────────── */
  .compose {
    margin: 0 40px;
    border: 1px solid var(--rule);
    border-top: none;
    background: rgba(20,18,15,0.5);
  }
  @media (max-width: 720px) { .compose { margin: 0 20px; } }
  .compose-head {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--rule);
  }
  .compose-label {
    font-family: var(--serif);
    font-size: 18px;
    font-weight: 400;
    font-style: italic;
    color: var(--ink);
    letter-spacing: -0.01em;
  }
  .compose-hint {
    flex: 1;
    font-family: var(--mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--ink-dim);
  }
  .compose-toggle {
    background: none;
    border: 0;
    color: var(--ink-dim);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    transition: transform 200ms ease, color 140ms;
  }
  .compose-toggle:hover { color: var(--vermilion); }
  .compose.collapsed .compose-toggle { transform: rotate(-90deg); }
  .compose.collapsed .compose-body { display: none; }
  .compose-body { padding: 18px; }
  .compose-body textarea {
    width: 100%;
    min-height: 56px;
    background: var(--paper);
    border: 1px solid var(--rule);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 12px;
    padding: 12px 14px;
    line-height: 1.55;
    resize: vertical;
    outline: none;
    transition: border-color 140ms;
  }
  .compose-body textarea:focus { border-color: var(--vermilion); }
  .compose-body textarea::placeholder { color: var(--ink-dim); font-style: italic; }
  .compose-row {
    display: flex;
    align-items: flex-end;
    gap: 24px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .ctrl { display: flex; flex-direction: column; gap: 6px; }
  .ctrl-label {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: #5d574d;
  }
  .select-wrap { position: relative; }
  .select-wrap::after {
    content: "▾";
    position: absolute;
    right: 12px; top: 50%;
    transform: translateY(-50%);
    color: var(--ink-dim);
    pointer-events: none;
    font-size: 10px;
  }
  .compose-body select {
    appearance: none;
    background: var(--paper);
    border: 1px solid var(--rule);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 11px;
    padding: 8px 28px 8px 12px;
    cursor: pointer;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    min-width: 140px;
    outline: none;
  }
  .compose-body select:focus { border-color: var(--vermilion); }
  .seg { display: flex; border: 1px solid var(--rule); }
  .seg-btn {
    background: var(--paper);
    color: var(--ink-dim);
    border: 0;
    border-right: 1px solid var(--rule);
    padding: 8px 14px;
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: all 140ms;
  }
  .seg-btn:last-child { border-right: 0; }
  .seg-btn:hover { color: var(--ink); }
  .seg-btn.active { background: var(--vermilion); color: var(--paper); }
  .seg-num .seg-btn { min-width: 42px; }
  .compose-spacer { flex: 1; }
  .char-count {
    font-family: var(--mono);
    font-size: 9px;
    color: var(--ink-dim);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    align-self: center;
  }
  .compose-submit {
    background: var(--vermilion);
    color: var(--paper);
    border: 1px solid var(--vermilion);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    padding: 12px 22px;
    cursor: pointer;
    transition: all 140ms;
  }
  .compose-submit:hover {
    background: var(--paper);
    color: var(--vermilion);
  }
  .compose-submit:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ─── Queue panel ───────────────────────────────────────────────── */
  .queue-panel {
    margin: 0 40px;
    border: 1px solid var(--rule);
    border-top: none;
    background: rgba(20,18,15,0.5);
  }
  @media (max-width: 720px) { .queue-panel { margin: 0 20px; } }
  .queue-head {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 18px;
    cursor: pointer;
  }
  .queue-label {
    font-family: var(--serif);
    font-style: italic;
    font-size: 16px;
    color: var(--vermilion);
  }
  .queue-counts {
    flex: 1;
    font-family: var(--mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--ink-dim);
  }
  .queue-toggle {
    background: none; border: 0; color: var(--ink-dim);
    font-size: 18px; cursor: pointer; padding: 4px 8px;
    transition: transform 200ms ease;
  }
  .queue-panel.expanded .queue-toggle { transform: rotate(180deg); }
  .queue-body { padding: 0 18px 18px; display: flex; flex-direction: column; gap: 10px; }
  .queue-body[hidden] { display: none; }
  .qjob {
    border-left: 2px solid var(--rule);
    padding: 10px 14px;
    background: var(--paper);
  }
  .qjob.running { border-left-color: var(--vermilion); }
  .qjob.cancelled { opacity: 0.4; }
  .qjob-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    font-family: var(--mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--ink-dim);
    margin-bottom: 6px;
  }
  .qjob-state { color: var(--vermilion); font-weight: 500; }
  .qjob-meta { color: #5d574d; }
  .qjob-spacer { flex: 1; }
  .qjob-cancel {
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-dim);
    font-family: var(--mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    padding: 4px 8px;
    cursor: pointer;
  }
  .qjob-cancel:hover { color: var(--vermilion); border-color: var(--vermilion); }
  .qjob-prompt {
    font-family: var(--serif);
    font-size: 14px;
    color: var(--ink);
    line-height: 1.45;
    margin-bottom: 4px;
  }
  .qjob-enhanced {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-dim);
    line-height: 1.5;
    border-top: 1px dotted var(--rule);
    padding-top: 6px;
    margin-top: 4px;
  }
  .qjob-enhanced::before {
    content: "→ ";
    color: var(--vermilion);
  }
  .qjob-progress {
    margin-top: 8px;
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .qjob-progress .pip {
    width: 14px; height: 4px;
    background: var(--rule);
  }
  .qjob-progress .pip.done { background: var(--vermilion); }

  /* Tile prompt caption line */
  .cap-prompt {
    font-family: var(--serif);
    font-style: italic;
    font-size: 11.5px;
    color: var(--ink);
    line-height: 1.4;
    margin: 4px 0 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .cap-tags {
    font-family: var(--mono);
    font-size: 9px;
    color: var(--vermilion);
    letter-spacing: 0.04em;
    line-height: 1.4;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── Pagination ────────────────────────────────────────────────── */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 32px 0 8px;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  .pagination .pg-arrow,
  .pagination .pg-num {
    color: var(--ink-dim);
    text-decoration: none;
    padding: 8px 12px;
    border: 1px solid var(--rule);
    transition: all 140ms;
  }
  .pagination a:hover { color: var(--vermilion); border-color: var(--vermilion); }
  .pagination .pg-num.current {
    color: var(--paper);
    background: var(--vermilion);
    border-color: var(--vermilion);
    font-weight: 500;
  }
  .pagination .pg-arrow.disabled { opacity: 0.3; pointer-events: none; }
  .pagination .pg-gap { color: #5d574d; padding: 0 4px; }
  @media (max-width: 720px) {
    .pagination { gap: 4px; font-size: 10px; }
    .pagination .pg-arrow, .pagination .pg-num { padding: 6px 10px; }
  }

  /* Empty-state link */
  .empty-link {
    display: inline-block;
    margin-top: 8px;
    color: var(--vermilion);
    text-decoration: none;
    border-bottom: 1px solid var(--vermilion);
    padding-bottom: 1px;
  }
  .empty-link:hover { color: var(--ink); border-color: var(--ink); }

  @media (max-width: 720px) {
    .compose-row { gap: 14px; }
    .compose.mobile-collapsed .compose-body { display: none; }
  }

  /* ─── Grid ────────────────────────────────────────────────────────── */
  .grid-wrap { padding: 28px 40px 0; }
  @media (max-width: 720px) { .grid-wrap { padding: 18px 20px 0; } }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 4px;
  }

  /* ─── Tile ────────────────────────────────────────────────────────── */
  .tile {
    position: relative;
    margin: 0;
    aspect-ratio: 1;
    background: var(--paper-2);
    cursor: zoom-in;
    overflow: hidden;
    opacity: 0;
    transform: translateY(8px);
    animation: rise 600ms cubic-bezier(.2,.7,.2,1) forwards;
    animation-delay: calc(var(--i) * 35ms + 100ms);
  }
  @keyframes rise {
    to { opacity: 1; transform: translateY(0); }
  }
  .tile-img { position: absolute; inset: 0; }
  .tile img {
    width: 100%; height: 100%;
    object-fit: cover; display: block;
    transition: transform 600ms cubic-bezier(.2,.7,.2,1), filter 200ms ease;
    filter: contrast(1.02) saturate(0.95);
  }
  .tile:hover img { transform: scale(1.04); filter: contrast(1.08) saturate(1); }
  .tile.selected { box-shadow: inset 0 0 0 2px var(--vermilion); }
  .tile.selected img { filter: contrast(1.06) saturate(0.85) brightness(0.85); }

  /* Caption — fully visible on hover, otherwise hidden */
  .tile figcaption {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 18px 14px 14px;
    background: linear-gradient(transparent, rgba(14,13,11,0.92) 60%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 220ms ease, transform 220ms ease;
    pointer-events: none;
  }
  .tile:hover figcaption { opacity: 1; transform: translateY(0); }
  .cap-kind {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.22em;
    color: var(--vermilion);
    text-transform: uppercase;
  }
  .cap-name {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cap-meta {
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--ink-dim);
    letter-spacing: 0.04em;
  }

  /* Selection button — minimal circle in top-left */
  .select {
    position: absolute;
    top: 12px;
    left: 12px;
    width: 22px; height: 22px;
    margin: 0; padding: 0;
    appearance: none;
    background: rgba(14,13,11,0.4);
    backdrop-filter: blur(8px);
    border: 1.5px solid rgba(245,240,232,0.55);
    border-radius: 50%;
    cursor: pointer;
    z-index: 3;
    transition: all 160ms ease;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--paper);
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
  }
  .select:hover { border-color: var(--ink); background: rgba(14,13,11,0.7); transform: scale(1.1); }
  .tile.selected .select {
    background: var(--vermilion);
    border-color: var(--vermilion);
  }
  .tile.selected .select::after {
    content: attr(data-order);
  }

  /* ─── Empty state ─────────────────────────────────────────────────── */
  .empty {
    grid-column: 1 / -1;
    padding: 100px 40px;
    text-align: center;
    border: 1px dashed var(--rule);
  }
  .empty-quote {
    font-family: var(--serif);
    font-style: italic;
    font-size: 32px;
    font-weight: 300;
    color: var(--ink);
    margin: 0 0 16px;
    letter-spacing: -0.01em;
  }
  .empty-hint {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-dim);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    margin: 0;
  }
  .empty-hint code { color: var(--vermilion); font-size: 11px; padding: 2px 6px; background: rgba(228,88,45,0.08); border-radius: 2px; }

  /* ─── Bottom action bar ───────────────────────────────────────────── */
  .bar {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    transform: translateY(110%);
    transition: transform 320ms cubic-bezier(.2,.7,.2,1);
    background: var(--paper);
    border-top: 1px solid var(--rule);
    z-index: 50;
  }
  .bar::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image: url("${grain}");
    background-size: 240px 240px;
    pointer-events: none;
    mix-blend-mode: overlay;
    opacity: 0.5;
  }
  .bar.visible { transform: translateY(0); }
  .bar-inner {
    position: relative;
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 20px 40px;
    max-width: 1600px;
    margin: 0 auto;
  }
  @media (max-width: 720px) { .bar-inner { padding: 16px 20px; gap: 12px; flex-wrap: wrap; } }
  .bar .bar-count {
    font-family: var(--serif);
    font-size: 28px;
    font-weight: 400;
    color: var(--ink);
    letter-spacing: -0.02em;
  }
  .bar .bar-count em {
    font-style: italic;
    font-weight: 300;
    color: var(--vermilion);
  }
  .bar .bar-label {
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--ink-dim);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    border-left: 1px solid var(--rule);
    padding-left: 16px;
    line-height: 1.4;
    max-width: 200px;
  }
  .bar .spacer { flex: 1; }
  .bar button {
    background: none;
    color: var(--ink);
    border: 1px solid var(--rule);
    padding: 12px 22px;
    font-family: var(--mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: all 140ms ease;
    border-radius: 0;
  }
  .bar button:hover { border-color: var(--ink); background: var(--paper-2); }
  .bar button.primary {
    background: var(--vermilion);
    border-color: var(--vermilion);
    color: var(--paper);
  }
  .bar button.primary:hover {
    background: var(--paper);
    color: var(--vermilion);
    border-color: var(--vermilion);
  }
  .bar button:disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
  .bar .status {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--vermilion);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    min-width: 140px;
  }

  /* ─── Lightbox ────────────────────────────────────────────────────── */
  .lightbox {
    position: fixed;
    inset: 0;
    background: rgba(14,13,11,0.96);
    display: none;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 24px;
    padding: 40px;
    z-index: 200;
    cursor: zoom-out;
  }
  .lightbox::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image: url("${grain}");
    background-size: 240px 240px;
    pointer-events: none;
    mix-blend-mode: overlay;
    opacity: 0.4;
  }
  .lightbox.open { display: flex; animation: fadein 280ms ease; }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
  .lightbox img {
    max-width: 92vw;
    max-height: 80vh;
    object-fit: contain;
    box-shadow: 0 30px 90px rgba(0,0,0,0.85);
    animation: scalein 320ms cubic-bezier(.2,.7,.2,1);
    position: relative;
    z-index: 1;
  }
  @keyframes scalein {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }
  .lightbox .lb-caption {
    position: relative;
    z-index: 1;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-dim);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    text-align: center;
    max-width: 80vw;
  }
  .lightbox .lb-caption strong { color: var(--ink); font-weight: 400; }
  .lightbox .lb-tags {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }
  .lightbox .lb-tag {
    color: var(--vermilion);
    text-decoration: none;
    padding: 4px 10px;
    border: 1px solid var(--vermilion);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: lowercase;
    letter-spacing: 0.06em;
    transition: all 140ms;
    cursor: pointer;
  }
  .lightbox .lb-tag:hover { background: var(--vermilion); color: var(--paper); }
  .lightbox .lb-prompt {
    margin-top: 14px;
    font-family: var(--serif);
    font-style: italic;
    font-size: 16px;
    line-height: 1.5;
    color: var(--ink);
    text-transform: none;
    letter-spacing: 0.005em;
    max-width: 80vw;
  }
  .lightbox .close {
    position: absolute;
    top: 24px;
    right: 28px;
    color: var(--ink);
    font-family: var(--serif);
    font-size: 36px;
    font-weight: 300;
    background: none;
    border: 0;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 160ms;
    z-index: 2;
    line-height: 1;
  }
  .lightbox .close:hover { opacity: 1; color: var(--vermilion); }

  /* ─── Footer ──────────────────────────────────────────────────────── */
  footer {
    margin-top: 60px;
    padding: 24px 40px;
    border-top: 1px solid var(--rule);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--ink-dim);
    flex-wrap: wrap;
    gap: 12px;
  }
  @media (max-width: 720px) { footer { padding: 20px; } }
  footer .lhs em { color: var(--vermilion); font-style: normal; }
</style>
</head>
<body>
  <header>
    <h1 class="mast">stock<em>·</em>archive
      <span class="mast-sub">a private catalog of generative imagery<br>z-image turbo · real-esrgan · sharp.js</span>
    </h1>
    <div class="meta-col">
      <div><span class="num">${String(filteredCount).padStart(3, "0")}</span> / ${tag ? `#${escapeHtml(tag === UNTAGGED_TOKEN ? "untagged" : tag)}` : "images"}</div>
      ${tag ? `<div class="of-total">of ${totalCount} total</div>` : `<div>${(totalBytes / 1e6).toFixed(1)} MB · page ${page}/${totalPages}</div>`}
      ${lastEntry ? `<div>last · ${escapeHtml(fmtTime(lastEntry.mtime))}</div>` : ""}
      <div class="hdr-queue" id="hdr-queue" style="display:none;">queue · <span id="hdr-queue-num">0</span></div>
      <div class="bar-count-label" id="hdr-selected" style="display:none;">— selected</div>
    </div>
  </header>

  <div class="running">
    <div><span class="label">Issue</span><span class="val">vol. 01</span></div>
    <div class="filter-cell">
      <span class="label">Filter</span>
      <div class="select-wrap tag-select-wrap">
        <select id="tag-filter">${tagOptions}</select>
      </div>
    </div>
    <div><span class="label">Resolution</span><span class="val">1024² · 2048²</span></div>
    <div><span class="label">Origin</span><span class="val">silverwulf.com</span></div>
  </div>

  <!-- ─── Compose panel ────────────────────────────────────────────── -->
  <section class="compose" id="compose">
    <div class="compose-head">
      <span class="compose-label">Compose</span>
      <span class="compose-hint">describe a subject · q3.5:4b enhances per style</span>
      <button class="compose-toggle" id="compose-toggle" type="button" aria-label="toggle">▾</button>
    </div>
    <div class="compose-body">
      <textarea id="cmp-prompt" placeholder="describe an image…" maxlength="${MAX_PROMPT_LEN}" rows="2"></textarea>
      <div class="compose-row">
        <label class="ctrl">
          <span class="ctrl-label">Style</span>
          <div class="select-wrap">
            <select id="cmp-style">${styleOptions}</select>
          </div>
        </label>
        <label class="ctrl">
          <span class="ctrl-label">Orient</span>
          <div class="seg" role="group">
            <button class="seg-btn" data-orient="square" type="button">square</button>
            <button class="seg-btn active" data-orient="landscape" type="button">landscape</button>
            <button class="seg-btn" data-orient="portrait" type="button">portrait</button>
          </div>
        </label>
        <label class="ctrl">
          <span class="ctrl-label">Vars</span>
          <div class="seg seg-num" role="group">
            <button class="seg-btn active" data-var="1" type="button">01</button>
            <button class="seg-btn" data-var="2" type="button">02</button>
            <button class="seg-btn" data-var="3" type="button">03</button>
            <button class="seg-btn" data-var="4" type="button">04</button>
          </div>
        </label>
        <div class="compose-spacer"></div>
        <span class="char-count" id="char-count">0 / ${MAX_PROMPT_LEN}</span>
        <button class="primary compose-submit" id="cmp-submit" type="button">Queue →</button>
      </div>
    </div>
  </section>

  <!-- ─── Queue panel (collapsible) ─────────────────────────────────── -->
  <section class="queue-panel" id="queue-panel" style="display:none;">
    <div class="queue-head">
      <span class="queue-label">Queue</span>
      <span class="queue-counts" id="queue-counts">— pending · — running</span>
      <button class="queue-toggle" id="queue-toggle" type="button" aria-label="expand">▾</button>
    </div>
    <div class="queue-body" id="queue-body" hidden></div>
  </section>

  <main class="grid-wrap">
    <div class="grid">${tiles}</div>
    ${pagination}
  </main>

  <footer>
    <div class="lhs">© silverwulf · <em>${fmtTime(Date.now())}</em></div>
    <div class="rhs">page ${page} of ${totalPages} · ${filteredCount} ${tag ? "filtered" : "total"} · all images cc · click any tile to enlarge</div>
  </footer>

  <div class="bar" id="bar">
    <div class="bar-inner">
      <span class="bar-count" id="bar-count"><em>0</em> selected</span>
      <span class="bar-label">batch operations<br>act on chosen images</span>
      <div class="spacer"></div>
      <span class="status" id="bar-status"></span>
      <button id="btn-clear">Clear</button>
      <button id="btn-zip">Download</button>
      <button class="primary" id="btn-upscale">Upscale → WebP</button>
    </div>
  </div>

  <div class="lightbox" id="lightbox">
    <button class="close" aria-label="close">×</button>
    <img id="lightbox-img" alt="">
    <div class="lb-caption" id="lightbox-caption"></div>
  </div>

  <script>
  (() => {
    const bar = document.getElementById('bar');
    const barCount = document.getElementById('bar-count');
    const barStatus = document.getElementById('bar-status');
    const hdrSelected = document.getElementById('hdr-selected');
    const btnUpscale = document.getElementById('btn-upscale');
    const btnZip = document.getElementById('btn-zip');
    const btnClear = document.getElementById('btn-clear');
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxCap = document.getElementById('lightbox-caption');

    function selected() {
      return Array.from(document.querySelectorAll('.tile.selected'))
        .map(t => t.dataset.name);
    }
    function refreshBar() {
      const tiles = Array.from(document.querySelectorAll('.tile.selected'));
      const n = tiles.length;
      barCount.innerHTML = '<em>' + String(n).padStart(2, '0') + '</em> selected';
      bar.classList.toggle('visible', n > 0);
      btnUpscale.disabled = n === 0;
      btnZip.disabled = n === 0;
      hdrSelected.style.display = n > 0 ? 'block' : 'none';
      hdrSelected.textContent = String(n).padStart(3, '0') + ' selected';
      // Renumber selection order
      tiles.forEach((t, i) => t.querySelector('.select').dataset.order = String(i + 1).padStart(2, '0'));
    }
    document.querySelectorAll('.tile').forEach(tile => {
      const cb = tile.querySelector('.select');
      cb.addEventListener('click', e => {
        e.stopPropagation();
        const isSelected = tile.classList.toggle('selected');
        cb.setAttribute('aria-pressed', String(isSelected));
        refreshBar();
      });
      tile.addEventListener('click', e => {
        if (e.target === cb) return;
        const name = tile.dataset.name;
        const cap = tile.querySelector('figcaption');
        const prompt = tile.dataset.prompt || '';
        const style = tile.dataset.style || '';
        const seed = tile.dataset.seed || '';
        const orient = tile.dataset.orient || '';
        const tags = (tile.dataset.tags || '').split(',').filter(Boolean);
        lightboxImg.src = name;
        lightboxImg.alt = name;
        const techLine = '<strong>' + name + '</strong>'
          + (style ? '  ·  ' + style.toUpperCase() : '')
          + (orient ? '  ·  ' + orient.toUpperCase() : '')
          + (seed ? '  ·  seed ' + seed : '')
          + '  ·  ' + cap.querySelector('.cap-meta').textContent;
        const promptLine = prompt ? '<div class="lb-prompt">"' + escapeHtmlClient(prompt) + '"</div>' : '';
        const tagLine = tags.length
          ? '<div class="lb-tags">' + tags.map(t => '<a class="lb-tag" href="/?tag=' + encodeURIComponent(t) + '">#' + escapeHtmlClient(t) + '</a>').join(' ') + '</div>'
          : '';
        lightboxCap.innerHTML = techLine + promptLine + tagLine;
        lightbox.classList.add('open');
      });
    });
    function escapeHtmlClient(s) {
      const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
    }
    lightbox.addEventListener('click', () => lightbox.classList.remove('open'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') lightbox.classList.remove('open'); });

    btnClear.addEventListener('click', () => {
      document.querySelectorAll('.tile.selected').forEach(t => {
        t.classList.remove('selected');
        t.querySelector('.select').setAttribute('aria-pressed', 'false');
      });
      refreshBar();
    });

    btnZip.addEventListener('click', async () => {
      const files = selected();
      if (!files.length) return;
      barStatus.textContent = 'packing zip…';
      try {
        const r = await fetch('/api/download-zip', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ files }) });
        if (!r.ok) throw new Error(await r.text());
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'stock-archive-' + Date.now() + '.zip';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        barStatus.textContent = '';
      } catch (e) { alert('zip failed: ' + e.message); barStatus.textContent = ''; }
    });

    btnUpscale.addEventListener('click', async () => {
      const files = selected();
      if (!files.length) return;
      btnUpscale.disabled = true; btnZip.disabled = true; btnClear.disabled = true;
      barStatus.textContent = 'starting…';
      const r = await fetch('/api/upscale', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ files }) });
      if (!r.ok) {
        alert('upscale failed: ' + await r.text());
        btnUpscale.disabled = false; btnZip.disabled = false; btnClear.disabled = false;
        barStatus.textContent = '';
        return;
      }
      const poll = setInterval(async () => {
        const sr = await fetch('/api/upscale/status');
        if (!sr.ok) return;
        const s = await sr.json();
        if (s.state === 'running') {
          barStatus.textContent = 'upscaling ' + String(s.done).padStart(2,'0') + ' / ' + String(s.total).padStart(2,'0');
        } else if (s.state === 'done') {
          barStatus.textContent = 'done · refreshing';
          clearInterval(poll);
          setTimeout(() => location.reload(), 600);
        } else {
          barStatus.textContent = 'error';
          clearInterval(poll);
          alert('upscale error: ' + (s.fatalError || ''));
          btnUpscale.disabled = false; btnZip.disabled = false; btnClear.disabled = false;
        }
      }, 1500);
    });

    refreshBar();

    // ─── Tag filter dropdown ────────────────────────────────────
    const tagFilter = document.getElementById('tag-filter');
    if (tagFilter) {
      tagFilter.addEventListener('change', () => {
        const v = tagFilter.value;
        location.href = v ? '/?tag=' + encodeURIComponent(v) : '/';
      });
    }

    // ─── Compose ────────────────────────────────────────────────
    const cmpPrompt = document.getElementById('cmp-prompt');
    const cmpStyle = document.getElementById('cmp-style');
    const cmpSubmit = document.getElementById('cmp-submit');
    const charCount = document.getElementById('char-count');
    const compose = document.getElementById('compose');
    const composeToggle = document.getElementById('compose-toggle');
    const orientButtons = compose.querySelectorAll('[data-orient]');
    const varButtons = compose.querySelectorAll('[data-var]');
    const MAX_LEN = ${MAX_PROMPT_LEN};
    let curOrient = 'landscape';
    let curVars = 1;

    cmpPrompt.addEventListener('input', () => {
      charCount.textContent = cmpPrompt.value.length + ' / ' + MAX_LEN;
    });
    orientButtons.forEach(b => b.addEventListener('click', () => {
      orientButtons.forEach(o => o.classList.remove('active'));
      b.classList.add('active');
      curOrient = b.dataset.orient;
    }));
    varButtons.forEach(b => b.addEventListener('click', () => {
      varButtons.forEach(o => o.classList.remove('active'));
      b.classList.add('active');
      curVars = Number(b.dataset.var);
    }));
    composeToggle.addEventListener('click', () => compose.classList.toggle('collapsed'));
    // Mobile: collapse by default
    if (window.matchMedia('(max-width: 720px)').matches) compose.classList.add('collapsed');

    cmpSubmit.addEventListener('click', async () => {
      const prompt = cmpPrompt.value.trim();
      if (!prompt) return;
      cmpSubmit.disabled = true;
      try {
        const r = await fetch('/api/generate', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({ prompt, style: cmpStyle.value, orientation: curOrient, variations: curVars }),
        });
        if (!r.ok) {
          const txt = await r.text();
          alert('queue failed (' + r.status + '): ' + txt);
        } else {
          cmpPrompt.value = '';
          charCount.textContent = '0 / ' + MAX_LEN;
          startPolling();
        }
      } catch (e) { alert('queue failed: ' + e.message); }
      finally { cmpSubmit.disabled = false; }
    });
    cmpPrompt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cmpSubmit.click(); }
    });

    // ─── Queue panel + polling ───────────────────────────────────
    const queuePanel = document.getElementById('queue-panel');
    const queueBody = document.getElementById('queue-body');
    const queueCounts = document.getElementById('queue-counts');
    const queueToggle = document.getElementById('queue-toggle');
    const queueHead = queuePanel.querySelector('.queue-head');
    const hdrQueue = document.getElementById('hdr-queue');
    const hdrQueueNum = document.getElementById('hdr-queue-num');
    let queueExpanded = false;
    let pollHandle = null;
    let lastFinishedTs = Date.now();

    queueHead.addEventListener('click', () => {
      queueExpanded = !queueExpanded;
      queuePanel.classList.toggle('expanded', queueExpanded);
      queueBody.hidden = !queueExpanded;
    });

    function renderQueue(state) {
      const running = state.running ? [state.running] : [];
      const all = running.concat(state.pending || []);
      // Header counts
      const pendN = (state.pending || []).length;
      const runN = state.running ? 1 : 0;
      queueCounts.textContent =
        String(pendN).padStart(2,'0') + ' pending · ' + (runN ? '01' : '00') + ' running';
      // Visibility
      const total = pendN + runN;
      queuePanel.style.display = total > 0 ? 'block' : 'none';
      hdrQueue.style.display = total > 0 ? 'block' : 'none';
      hdrQueueNum.textContent = String(total).padStart(2,'0');
      // Body
      queueBody.innerHTML = all.map(j => {
        const isRunning = j.state === 'running' || j.state === 'enhancing';
        const pips = Array.from({length: j.variations}, (_, i) =>
          '<span class="pip ' + (i < (j.done || 0) ? 'done' : '') + '"></span>'
        ).join('');
        return '<div class="qjob ' + (isRunning ? 'running' : '') + '">'
          + '<div class="qjob-head">'
          +   '<span class="qjob-state">' + (j.state || '').toUpperCase() + '</span>'
          +   '<span class="qjob-meta">' + (j.style||'') + ' · ' + (j.orientation||'') + ' · ' + (j.variations||1) + 'x</span>'
          +   '<span class="qjob-spacer"></span>'
          +   (j.state === 'pending'
                ? '<button class="qjob-cancel" data-cancel-id="' + j.id + '">cancel</button>'
                : '')
          + '</div>'
          + '<div class="qjob-prompt">' + escapeHtmlClient(j.prompt || '') + '</div>'
          + (j.enhancedPrompt && j.enhancedPrompt !== j.prompt
              ? '<div class="qjob-enhanced">' + escapeHtmlClient(j.enhancedPrompt) + '</div>'
              : '')
          + (isRunning ? '<div class="qjob-progress">' + pips + '</div>' : '')
          + '</div>';
      }).join('');
      // Wire cancel buttons
      queueBody.querySelectorAll('[data-cancel-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.cancelId;
          await fetch('/api/queue/' + id, { method: 'DELETE' });
        });
      });
    }

    async function pollQueue() {
      try {
        const r = await fetch('/api/queue');
        if (!r.ok) return;
        const s = await r.json();
        renderQueue(s);
        const empty = !s.running && (!s.pending || s.pending.length === 0);
        // Did the most recent finished happen after this page loaded? → reload
        const lastFin = (s.finished || []).find(j => j.state === 'done' || j.state === 'error');
        if (empty && lastFin && lastFin.finishedAt > lastFinishedTs) {
          stopPolling();
          setTimeout(() => location.reload(), 400);
          return;
        }
        if (empty) stopPolling();
      } catch (e) { /* ignore transient */ }
    }
    function startPolling() {
      if (pollHandle) return;
      lastFinishedTs = Date.now();
      pollQueue();
      pollHandle = setInterval(pollQueue, 1500);
    }
    function stopPolling() {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    }
    // On load: start polling if queue is non-empty
    pollQueue().then(() => {
      if (queuePanel.style.display === 'block') startPolling();
    });
  })();
  </script>
</body>
</html>
`;
}

// ---------- HTTP server ----------
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error("body too large")); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;

    // GET / → dynamic index (paginated, optionally filtered)
    if (req.method === "GET" && p === "/") {
      const pageNum = Math.max(1, Number(url.searchParams.get("p")) || 1);
      const tagFilter = url.searchParams.get("tag") || null;
      // Cache key includes page + tag, only for the first 4 pages of unfiltered or the most common filter views
      const cacheKey = `stockgal:html:p${pageNum}:t${tagFilter || ""}`;
      const html = await cached(cacheKey, CACHE_HTML_TTL, async () => {
        const items = await listGallery();
        const sidecars = await cached("stockgal:sidecars", CACHE_TTL_SECONDS, () => readAllSidecars(items));
        const tagIndex = await cached("stockgal:tagindex", CACHE_TTL_SECONDS, async () => buildTagIndex(items, sidecars));
        const pagination = paginateAndFilter(items, sidecars, { page: pageNum, tag: tagFilter });
        return await renderIndex({ ...pagination, sidecars, tagIndex });
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, must-revalidate" });
      res.end(html);
      return;
    }

    // GET /api/tags → tag index for the filter dropdown
    if (req.method === "GET" && p === "/api/tags") {
      const items = await listGallery();
      const sidecars = await cached("stockgal:sidecars", CACHE_TTL_SECONDS, () => readAllSidecars(items));
      const idx = await cached("stockgal:tagindex", CACHE_TTL_SECONDS, async () => buildTagIndex(items, sidecars));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(idx));
      return;
    }

    // GET /api/upscale/status
    if (req.method === "GET" && p === "/api/upscale/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(currentJob || { state: "idle" }));
      return;
    }

    // GET /api/styles → list of style options for the dropdown
    if (req.method === "GET" && p === "/api/styles") {
      const out = Object.entries(STYLES).map(([k, v]) => ({ key: k, label: v.label, description: v.description }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }

    // GET /api/queue → {running, pending, finishedHistory}
    if (req.method === "GET" && p === "/api/queue") {
      const summarize = j => j && {
        id: j.id, state: j.state, prompt: j.prompt, enhancedPrompt: j.enhancedPrompt,
        enhanceFailed: j.enhanceFailed, style: j.style, orientation: j.orientation,
        variations: j.variations, done: j.done, currentVariation: j.currentVariation,
        results: j.results, errors: j.errors, submittedAt: j.submittedAt, finishedAt: j.finishedAt,
        fatalError: j.fatalError,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        running: summarize(runningJob),
        pending: queue.map(summarize),
        finished: finishedHistory.slice(0, 5).map(summarize),
      }));
      return;
    }

    // POST /api/generate {prompt, style, variations, orientation}
    if (req.method === "POST" && p === "/api/generate") {
      let body;
      try { body = await readJsonBody(req); } catch (e) { res.writeHead(400); res.end("invalid json"); return; }
      const prompt = String(body.prompt || "").trim();
      const style = String(body.style || "raw");
      const orientation = String(body.orientation || "square");
      const variations = Math.min(4, Math.max(1, Number(body.variations) || 1));
      if (!prompt) { res.writeHead(400); res.end("prompt required"); return; }
      if (prompt.length > MAX_PROMPT_LEN) { res.writeHead(400); res.end(`prompt > ${MAX_PROMPT_LEN} chars`); return; }
      if (!STYLES[style]) { res.writeHead(400); res.end(`unknown style: ${style}`); return; }
      if (!ORIENTATIONS[orientation]) { res.writeHead(400); res.end(`unknown orientation: ${orientation}`); return; }
      try {
        const job = enqueueJob({ prompt, style, orientation, variations });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: job.id, position: queue.length }));
      } catch (e) {
        res.writeHead(e.code || 500); res.end(e.message);
      }
      return;
    }

    // DELETE /api/queue/:id → mark cancelled (worker drops on shift)
    if (req.method === "DELETE" && /^\/api\/queue\/\d+$/.test(p)) {
      const id = Number(p.split("/").pop());
      const j = queue.find(x => x.id === id);
      if (!j) { res.writeHead(404); res.end("not found in pending queue"); return; }
      if (j.state !== "pending") { res.writeHead(409); res.end("job already started"); return; }
      j.state = "cancelled";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, state: "cancelled" }));
      return;
    }

    // POST /api/upscale
    if (req.method === "POST" && p === "/api/upscale") {
      const body = await readJsonBody(req);
      const files = (body.files || []).filter(f => typeof f === "string" && safeFilename(f));
      if (!files.length) { res.writeHead(400); res.end("no valid files"); return; }
      const job = await runUpscaleBatch(files).catch(e => ({ error: e.message }));
      if (job.error) { res.writeHead(409); res.end(job.error); return; }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: job.id, total: job.total }));
      return;
    }

    // POST /api/download-zip
    if (req.method === "POST" && p === "/api/download-zip") {
      const body = await readJsonBody(req);
      const files = (body.files || []).filter(f => typeof f === "string" && safeFilename(f) && existsSync(path.join(GALLERY_DIR, f)));
      if (!files.length) { res.writeHead(400); res.end("no valid files"); return; }
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="stock-gallery-${Date.now()}.zip"`,
      });
      const zip = archiver("zip", { zlib: { level: 6 } });
      zip.on("error", err => { res.destroy(err); });
      zip.pipe(res);
      for (const f of files) {
        zip.append(createReadStream(path.join(GALLERY_DIR, f)), { name: f });
      }
      await zip.finalize();
      return;
    }

    // GET /thumb/<file> → lazy-generated 480² WebP thumbnail
    if (req.method === "GET" && p.startsWith("/thumb/")) {
      const name = decodeURIComponent(p.slice("/thumb/".length));
      if (!safeFilename(name)) { res.writeHead(404); res.end(); return; }
      const base = name.replace(/\.[^.]+$/, "");
      const thumbPath = path.join(THUMBS_DIR, `${base}.webp`);
      if (!existsSync(thumbPath)) {
        try { await generateThumb(name); }
        catch (e) { await log(`thumb gen failed for ${name}: ${e.message}`); res.writeHead(404); res.end(); return; }
      }
      const s = await stat(thumbPath);
      res.writeHead(200, {
        "content-type": "image/webp",
        "content-length": s.size,
        "cache-control": "public, max-age=31536000, immutable",
      });
      createReadStream(thumbPath).pipe(res);
      return;
    }

    // GET /<file> → static image
    if (req.method === "GET" && /^\/[^/]+\.(png|jpe?g|webp)$/i.test(p)) {
      const name = decodeURIComponent(p.slice(1));
      if (!safeFilename(name)) { res.writeHead(404); res.end(); return; }
      const fp = path.join(GALLERY_DIR, name);
      if (!existsSync(fp)) { res.writeHead(404); res.end(); return; }
      const ext = name.split(".").pop().toLowerCase();
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "application/octet-stream";
      const s = await stat(fp);
      res.writeHead(200, {
        "content-type": mime,
        "content-length": s.size,
        "cache-control": "public, max-age=31536000, immutable",
      });
      createReadStream(fp).pipe(res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    await log(`HTTP error ${req.method} ${req.url}: ${e.stack || e.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(e.message); }
  }
});

server.listen(PORT, () => {
  log(`stock-gallery listening on :${PORT}`);
  startWorker();
});
