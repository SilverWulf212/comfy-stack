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
import sharp from "sharp";
import Docker from "dockerode";
import archiver from "archiver";

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

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS  = 5 * 60 * 1000;

// ---------- Utilities ----------
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

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
function deepReplace(node, vars) {
  if (typeof node === "string") {
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
  return { input: filename, output: outName, bytes: webpBuf.length };
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
function renderIndex(items) {
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

  const totalBytes = items.reduce((a, s) => a + s.size, 0);
  const lastEntry = items[0];

  const tiles = items.length === 0
    ? `<div class="empty">
         <p class="empty-quote">"The archive is empty."</p>
         <p class="empty-hint">Generate the first image with the <code>generate_image</code> MCP tool.</p>
       </div>`
    : items.map((s, i) => `
    <figure class="tile" data-name="${escapeHtml(s.name)}" style="--i:${i}">
      <button class="select" type="button" aria-label="select ${escapeHtml(s.name)}" aria-pressed="false"></button>
      <div class="tile-img"><img src="${escapeHtml(s.name)}" loading="lazy" alt="${escapeHtml(s.name)}"></div>
      <figcaption>
        <span class="cap-kind">${escapeHtml(fmtKind(s.name))}</span>
        <span class="cap-name">${escapeHtml(s.name.replace(/\.[^.]+$/, ""))}</span>
        <span class="cap-meta">${fmtTime(s.mtime)} · ${fmtSize(s.size)}</span>
      </figcaption>
    </figure>`).join("");

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
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
    max-width: 420px;
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
      <span class="mast-sub">A private catalog of generative imagery — z-image turbo on rtx 4060, post-processed via real-esrgan + sharp.js</span>
    </h1>
    <div class="meta-col">
      <div><span class="num">${String(items.length).padStart(3, "0")}</span> / images</div>
      <div>${(totalBytes / 1e6).toFixed(1)} MB</div>
      ${lastEntry ? `<div>last · ${escapeHtml(fmtTime(lastEntry.mtime))}</div>` : ""}
      <div class="bar-count-label" id="hdr-selected" style="display:none;">— selected</div>
    </div>
  </header>

  <div class="running">
    <div><span class="label">Issue</span><span class="val">vol. 01</span></div>
    <div><span class="label">Compiler</span><span class="val">comfy-mcp</span></div>
    <div><span class="label">Resolution</span><span class="val">1024² · 2048²</span></div>
    <div><span class="label">Origin</span><span class="val">silverwulf.com</span></div>
  </div>

  <main class="grid-wrap">
    <div class="grid">${tiles}</div>
  </main>

  <footer>
    <div class="lhs">© silverwulf · <em>${fmtTime(Date.now())}</em></div>
    <div class="rhs">no. ${String(items.length).padStart(4, "0")} · all images cc · click any tile to enlarge</div>
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
        lightboxImg.src = name;
        lightboxImg.alt = name;
        lightboxCap.innerHTML = '<strong>' + name + '</strong>  ·  ' + cap.querySelector('.cap-meta').textContent;
        lightbox.classList.add('open');
      });
    });
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

    // GET / → dynamic index
    if (req.method === "GET" && p === "/") {
      const items = await listGallery();
      const html = renderIndex(items);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, must-revalidate" });
      res.end(html);
      return;
    }

    // GET /api/upscale/status
    if (req.method === "GET" && p === "/api/upscale/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(currentJob || { state: "idle" }));
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

server.listen(PORT, () => log(`stock-gallery listening on :${PORT}`));
