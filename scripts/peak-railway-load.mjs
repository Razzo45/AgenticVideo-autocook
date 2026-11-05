/**
 * Peak traffic against Railway Autocook — real cooks (video/image/html/pptx/pdf/audio).
 *
 * Auth: AUTOCOOK_SERVICE_TOKEN + X-User-Id (AUTH_MODE=strict).
 * Token can come from env, or is pulled from linked Railway `web` service.
 *
 * Usage:
 *   node scripts/peak-railway-load.mjs
 *   BASE_URL=https://web-production-94c5b.up.railway.app USERS=4 node scripts/peak-railway-load.mjs
 *
 * Env knobs:
 *   BASE_URL, AUTOCOOK_SERVICE_TOKEN, USERS (default 3), POLL_MS (10000), TIMEOUT_MS (3600000)
 */
import { spawnSync } from "node:child_process";

const BASE = (process.env.BASE_URL || "https://web-production-94c5b.up.railway.app").replace(/\/$/, "");
const USERS = Math.max(1, Number(process.env.USERS || 3));
const POLL_MS = Number(process.env.POLL_MS || 10_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60 * 60 * 1000);

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
  throw new Error("AUTOCOOK_SERVICE_TOKEN missing (set env or Railway web vars)");
}

const TOKEN = loadToken();

/** One "peak seat" per synthetic user — mix of kinds that hit Gemini hard. */
function jobsForUser(userId, wave) {
  const tag = `${userId}-w${wave}-${Date.now().toString(36)}`;
  return [
    {
      kind: "video",
      requestId: `${tag}-video`,
      prompt:
        "8-second 16:9 product spot: ceramic mug on oak table, soft window light, gentle steam, no people, no text, no logos. One calm beat.",
    },
    {
      kind: "image",
      requestId: `${tag}-image`,
      prompt:
        "Single hero still, 1:1: matte black wireless earbuds in an open charging case on white marble. Soft studio light, no text, no logos, photoreal.",
    },
    {
      kind: "html",
      requestId: `${tag}-html`,
      prompt:
        "One-page HTML landing for a fictional tea brand 'Harbor Leaf'. Hero headline, three feature cards, muted green palette, embed one generated product still. Export as zip-ready site.",
    },
    {
      kind: "pptx",
      requestId: `${tag}-pptx`,
      prompt:
        "3-slide PPTX pitch: title 'Harbor Leaf Q1', problem/solution, and a simple roadmap. Include one generated product image on slide 2. Clean corporate look.",
    },
    {
      kind: "pdf",
      requestId: `${tag}-pdf`,
      prompt:
        "One-page PDF one-pager for Harbor Leaf: headline, three bullets, small product still. Clean print layout.",
    },
    {
      kind: "audio",
      requestId: `${tag}-audio`,
      prompt:
        '20-second podcast bumper: host says "Welcome to Harbor Leaf Radio." Soft instrumental bed, no other vocals.',
    },
  ];
}

async function cook(userId, job) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/cook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-user-id": userId,
    },
    body: JSON.stringify({
      prompt: job.prompt,
      kind: job.kind,
      requestId: job.requestId,
      category: "E-commerce & Advertising",
      sessionLabel: `peak-${job.kind}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, userId, kind: job.kind, requestId: job.requestId, status: res.status, error: json.error || res.statusText, ms };
  }
  if (json.blocked) {
    return { ok: false, userId, kind: job.kind, requestId: job.requestId, status: 200, error: "preflight hardBlock", ms, blocked: true };
  }
  return {
    ok: true,
    userId,
    kind: job.kind,
    requestId: job.requestId,
    runId: json.run?.id,
    status: json.run?.status,
    ms,
  };
}

async function listRuns(userId) {
  const res = await fetch(`${BASE}/api/runs`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-user-id": userId },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`list ${userId}: ${json.error || res.status}`);
  return json.runs || [];
}

function terminal(status) {
  return status === "exported" || status === "failed" || status === "rejected";
}

async function main() {
  console.log(`[peak] BASE=${BASE} users=${USERS}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log("[peak] health", health);

  const userIds = Array.from({ length: USERS }, (_, i) => `peak-user-${i + 1}`);
  const enqueue = [];
  for (const u of userIds) {
    for (const job of jobsForUser(u, 1)) enqueue.push({ userId: u, job });
  }
  console.log(`[peak] firing ${enqueue.length} real cooks in parallel…`);

  const enqueued = await Promise.all(enqueue.map(({ userId, job }) => cook(userId, job)));
  const ok = enqueued.filter((r) => r.ok);
  const bad = enqueued.filter((r) => !r.ok);
  console.log(`[peak] enqueue ok=${ok.length} fail=${bad.length}`);
  for (const b of bad) console.log("  FAIL", b.kind, b.userId, b.status, b.error);
  for (const r of ok) console.log("  RUN", r.kind, r.userId, r.runId, `${r.ms}ms`);

  const watch = new Map(ok.filter((r) => r.runId).map((r) => [r.runId, r]));
  if (!watch.size) {
    console.error("[peak] nothing to watch");
    process.exit(2);
  }

  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let pending = 0;
    let exported = 0;
    let failed = 0;
    const byStatus = {};
    for (const userId of userIds) {
      let runs;
      try {
        runs = await listRuns(userId);
      } catch (err) {
        console.warn("[peak] list error", err.message || err);
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
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(
      `[peak] t=${elapsed}s watching=${watch.size} pending=${pending} exported=${exported} failed=${failed} statuses=${JSON.stringify(byStatus)}`,
    );
    if (pending === 0 && exported + failed >= watch.size) {
      console.log("[peak] all watched runs terminal");
      break;
    }
  }

  console.log("[peak] final snapshot");
  for (const userId of userIds) {
    const runs = await listRuns(userId).catch(() => []);
    for (const run of runs) {
      if (!watch.has(run.id)) continue;
      const meta = watch.get(run.id);
      console.log(
        JSON.stringify({
          userId,
          kind: meta.kind,
          runId: run.id,
          status: run.status,
          error: run.error,
          live: run.live,
        }),
      );
    }
  }
}

main().catch((err) => {
  console.error("[peak] FATAL", err);
  process.exit(1);
});
