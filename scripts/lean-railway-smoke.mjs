/**
 * Minimal Railway verification — one user, four short cooks.
 * Covers: /api/runs polling, S3 persist, Zod doc plan, video path, audio path.
 * Skips html/pdf (same Zod surface as image) and multi-user burst.
 *
 *   node scripts/lean-railway-smoke.mjs
 */
import { spawnSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "https://web-production-94c5b.up.railway.app").replace(/\/$/, "");
const USER = process.env.SMOKE_USER || "lean-smoke-1";
const POLL_MS = Number(process.env.POLL_MS || 8_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45 * 60_000);

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
const tag = `lean-${Date.now().toString(36)}`;

/** Short briefs — enough to exercise the pipeline, not burn a full peak. */
const JOBS = [
  {
    kind: "image",
    requestId: `${tag}-image`,
    prompt:
      "One 1024 square PNG: simple ceramic mug on white background, soft light, no text, no logos. Photoreal still only.",
  },
  {
    kind: "pptx",
    requestId: `${tag}-pptx`,
    prompt:
      "2-slide PPTX: title 'Lean Smoke' and one bullet slide with three short points. No images required.",
  },
  {
    kind: "audio",
    requestId: `${tag}-audio`,
    prompt: '12-second bumper: a calm host says "Smoke test complete." Soft bed, no other vocals.',
  },
  {
    kind: "video",
    requestId: `${tag}-video`,
    prompt:
      "6-second 16:9 clip: ceramic mug on oak table, soft window light, gentle steam, no people, no text, no logos.",
  },
];

async function cook(job) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/cook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-user-id": USER,
    },
    body: JSON.stringify({
      prompt: job.prompt,
      kind: job.kind,
      requestId: job.requestId,
      category: "E-commerce & Advertising",
      sessionLabel: `lean-${job.kind}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, kind: job.kind, status: res.status, error: json.error || res.statusText, ms };
  if (json.blocked) return { ok: false, kind: job.kind, error: "preflight hardBlock", ms };
  return { ok: true, kind: job.kind, runId: json.run?.id, ms };
}

async function listRuns() {
  const res = await fetch(`${BASE}/api/runs`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-user-id": USER },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`list: ${json.error || res.status}`);
  return json.runs || [];
}

function terminal(status) {
  return status === "exported" || status === "failed" || status === "rejected";
}

async function main() {
  console.log(`[lean] BASE=${BASE} user=${USER} jobs=${JOBS.length}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log("[lean] health", health);

  // Sequential enqueue — avoids slamming Argon/preflight/Gemini at once.
  const ok = [];
  for (const job of JOBS) {
    const r = await cook(job);
    if (r.ok) {
      console.log(`[lean] enqueue ${r.kind} ${r.runId} ${r.ms}ms`);
      ok.push(r);
    } else {
      console.log(`[lean] FAIL enqueue ${r.kind}`, r.error || r.status);
    }
  }
  const watch = new Map(ok.filter((r) => r.runId).map((r) => [r.runId, r]));
  if (!watch.size) {
    console.error("[lean] nothing to watch");
    process.exit(2);
  }

  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let pending = 0;
    let exported = 0;
    let failed = 0;
    const byStatus = {};
    let runs;
    try {
      runs = await listRuns();
    } catch (err) {
      console.warn("[lean] list error", err.message || err);
      continue;
    }
    for (const run of runs) {
      if (!watch.has(run.id)) continue;
      byStatus[run.status] = (byStatus[run.status] || 0) + 1;
      if (terminal(run.status)) {
        if (run.status === "exported") exported++;
        else failed++;
      } else pending++;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(
      `[lean] t=${elapsed}s watching=${watch.size} pending=${pending} exported=${exported} failed=${failed} statuses=${JSON.stringify(byStatus)}`,
    );
    if (pending === 0 && exported + failed >= watch.size) {
      console.log("[lean] all terminal");
      break;
    }
  }

  console.log("[lean] final");
  const runs = await listRuns().catch(() => []);
  for (const run of runs) {
    if (!watch.has(run.id)) continue;
    const meta = watch.get(run.id);
    console.log(
      JSON.stringify({
        kind: meta.kind,
        runId: run.id,
        status: run.status,
        error: run.error,
        live: run.live,
      }),
    );
  }
}

main().catch((err) => {
  console.error("[lean] FATAL", err);
  process.exit(1);
});
