/**
 * Sequential E2E for every cook deliverable: enqueue → wait → download via /api/media.
 *
 *   node scripts/e2e-deliverables.mjs
 *   KINDS=image,pptx node scripts/e2e-deliverables.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "https://web-production-94c5b.up.railway.app").replace(/\/$/, "");
const USER = process.env.E2E_USER || "e2e-deliverables-1";
const POLL_MS = Number(process.env.POLL_MS || 8_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 50 * 60_000);
const OUT_DIR = path.resolve("tmp", "e2e-downloads");

function loadToken() {
  if (process.env.AUTOCOOK_SERVICE_TOKEN?.trim()) return process.env.AUTOCOOK_SERVICE_TOKEN.trim();
  const r = spawnSync(
    "npx",
    ["--yes", "@railway/cli@latest", "variable", "list", "--service", "web", "--kv"],
    { encoding: "utf8", shell: true },
  );
  if (r.status !== 0) throw new Error(`railway variable list failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const m = line.match(/^AUTOCOOK_SERVICE_TOKEN=(.*)$/);
    if (m) return m[1].trim();
  }
  throw new Error("AUTOCOOK_SERVICE_TOKEN missing");
}

const TOKEN = loadToken();
const tag = `e2e-${Date.now().toString(36)}`;

const ALL_JOBS = {
  image: {
    kind: "image",
    prompt:
      "One square PNG still: matte ceramic mug on plain white seamless, soft studio light, no text, no logos.",
  },
  pptx: {
    kind: "pptx",
    prompt:
      "2-slide PPTX titled 'E2E Deliverable'. Slide 1 title only. Slide 2 three short bullets. No images.",
  },
  html: {
    kind: "html",
    prompt:
      "Single-file HTML page titled 'E2E Harbor'. One headline, one paragraph, muted green CSS. No external assets required.",
  },
  pdf: {
    kind: "pdf",
    prompt:
      "One-page PDF flyer: headline 'E2E Leaf', three short bullets, clean print layout. Prefer HTML→PDF. No stock photos required.",
  },
  audio: {
    kind: "audio",
    prompt: '10-second bumper: host says "Deliverable check complete." Soft instrumental bed only besides that line.',
  },
  video: {
    kind: "video",
    prompt:
      "6-second 16:9 clip: ceramic mug on oak table, soft window light, gentle steam, no people, no text, no logos.",
  },
};

const kindFilter = (process.env.KINDS || "image,pptx,html,pdf,audio,video")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const JOBS = kindFilter.map((k) => {
  const j = ALL_JOBS[k];
  if (!j) throw new Error(`Unknown kind ${k}`);
  return { ...j, requestId: `${tag}-${k}` };
});

function authHeaders() {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-user-id": USER,
  };
}

async function cook(job) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/cook`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      prompt: job.prompt,
      kind: job.kind,
      requestId: job.requestId,
      category: "E-commerce & Advertising",
      sessionLabel: `e2e-${job.kind}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  return {
    ok: res.ok && !json.blocked,
    kind: job.kind,
    runId: json.run?.id,
    ms: Date.now() - t0,
    error: json.error || (json.blocked ? "hardBlock" : res.statusText),
  };
}

async function getRun(runId) {
  const res = await fetch(`${BASE}/api/runs/${runId}`, { headers: authHeaders() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`get ${runId}: ${json.error || res.status}`);
  return json;
}

function mediaRel(absOrRel) {
  const cwd = String(absOrRel).replaceAll("\\", "/");
  const idx = cwd.toLowerCase().indexOf("/runs/");
  if (idx >= 0) return cwd.slice(idx + 1);
  if (cwd.startsWith("runs/")) return cwd;
  return cwd;
}

async function downloadFinal(finalPath, kind, runId) {
  const rel = mediaRel(finalPath);
  const url = `${BASE}/api/media?path=${encodeURIComponent(rel)}&download=1`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get("content-type") || "";
  const disp = res.headers.get("content-disposition") || "";
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ext = path.extname(rel) || ".bin";
  const out = path.join(OUT_DIR, `${kind}-${runId}${ext}`);
  if (res.ok && buf.length > 0) fs.writeFileSync(out, buf);
  return {
    ok: res.ok && buf.length > 64,
    status: res.status,
    bytes: buf.length,
    ctype,
    disposition: disp,
    file: out,
    rel,
  };
}

function terminal(status) {
  return status === "exported" || status === "failed" || status === "rejected";
}

async function waitExported(runId, kind) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const detail = await getRun(runId);
    const run = detail.run || detail;
    const status = run.status;
    const err = run.error;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(
      `\r[e2e] ${kind} ${runId} t=${elapsed}s status=${status} ${err ? String(err).slice(0, 60) : ""}   `,
    );
    if (terminal(status)) {
      console.log("");
      return detail;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timeout waiting for ${kind} ${runId}`);
}

async function main() {
  console.log(`[e2e] BASE=${BASE} user=${USER} kinds=${kindFilter.join(",")}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log("[e2e] health", health);

  const results = [];
  for (const job of JOBS) {
    console.log(`\n[e2e] === ${job.kind} ===`);
    const enq = await cook(job);
    if (!enq.ok || !enq.runId) {
      console.log(`[e2e] enqueue FAIL`, enq);
      results.push({ kind: job.kind, ok: false, stage: "enqueue", error: enq.error });
      continue;
    }
    console.log(`[e2e] enqueued ${enq.runId} in ${enq.ms}ms`);
    let detail;
    try {
      detail = await waitExported(enq.runId, job.kind);
    } catch (err) {
      results.push({ kind: job.kind, runId: enq.runId, ok: false, stage: "wait", error: String(err) });
      continue;
    }
    const run = detail.run || detail;
    if (run.status !== "exported") {
      console.log(`[e2e] ${job.kind} FAILED:`, run.error);
      results.push({
        kind: job.kind,
        runId: enq.runId,
        ok: false,
        stage: "cook",
        status: run.status,
        error: run.error,
      });
      continue;
    }
    const finalPath = detail.finalPath;
    if (!finalPath) {
      results.push({
        kind: job.kind,
        runId: enq.runId,
        ok: false,
        stage: "finalPath",
        error: "exported but finalPath null",
      });
      continue;
    }
    const dl = await downloadFinal(finalPath, job.kind, enq.runId);
    console.log(
      `[e2e] download ${dl.ok ? "OK" : "FAIL"} ${dl.bytes}B ${dl.ctype} → ${dl.file}`,
    );
    results.push({
      kind: job.kind,
      runId: enq.runId,
      ok: dl.ok,
      stage: "download",
      status: run.status,
      finalPath,
      bytes: dl.bytes,
      ctype: dl.ctype,
      disposition: dl.disposition,
      file: dl.file,
      error: dl.ok ? null : `HTTP ${dl.status} or empty body`,
    });
  }

  console.log("\n[e2e] SUMMARY");
  for (const r of results) {
    console.log(
      JSON.stringify({
        kind: r.kind,
        ok: r.ok,
        stage: r.stage,
        runId: r.runId,
        bytes: r.bytes,
        ctype: r.ctype,
        error: r.error,
      }),
    );
  }
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`[e2e] pass=${pass} fail=${fail}`);
  fs.mkdirSync("tmp", { recursive: true });
  fs.writeFileSync("tmp/e2e-deliverables-summary.json", JSON.stringify(results, null, 2));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e] FATAL", err);
  process.exit(1);
});
