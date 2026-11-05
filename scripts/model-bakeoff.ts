/**
 * Side-by-side I2V bake-off: same still + motion prompt, request 10s.
 * Veo 3.1 Lite/Fast catalog max is 8s — those snap to 8s and are labeled as such.
 *
 *   npx tsx scripts/model-bakeoff.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generateVideo, inspectVideoModel, snapDuration } from "../src/pipeline/openrouter";

function loadDotEnv() {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "runs", "bakeoff_10s_shot0");
const KEYFRAME = path.join(
  ROOT,
  "dataset",
  "agentic_poc",
  "image",
  "agent_generated",
  "sess_anime_3716eae0_shot0_kf.png",
);
const MOTION = `Slow dolly zoom towards the Viking. Rain pours down, splashing on the pavement. The Viking exhales a cloud of mist, his eyes locked on the android. He slowly reaches his hand over his shoulder. The sounds of heavy rain, distant city hums, and the creak of leather.`;
const REQUESTED_SEC = 10;

type Candidate = {
  id: string;
  slug: string;
  resolution: string;
  note: string;
};

const CANDIDATES: Candidate[] = [
  {
    id: "veo-3.1-lite",
    slug: "google/veo-3.1-lite",
    resolution: "1080p",
    note: "Catalog max 8s — will snap off 10s.",
  },
  {
    id: "wan-2.7",
    slug: "alibaba/wan-2.7",
    resolution: "1080p",
    note: "True 10s candidate.",
  },
  {
    id: "seedance-1.5-pro",
    slug: "bytedance/seedance-1-5-pro",
    resolution: "1080p",
    note: "True 10s candidate (token SKU).",
  },
  {
    id: "veo-3.1-fast",
    slug: "google/veo-3.1-fast",
    resolution: "1080p",
    note: "Catalog max 8s — will snap off 10s.",
  },
  {
    id: "hailuo-3",
    slug: "minimax/hailuo-3",
    resolution: "2K",
    note: "True 10s candidate. Catalog lists 2K, not 1080p.",
  },
];

type Probe = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vCodec: string | null;
  aCodec: string | null;
  bytes: number;
};

function probeFile(file: string): Probe {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ],
    { encoding: "utf8" },
  );
  const j = JSON.parse(raw) as {
    format?: { duration?: string, size?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }>;
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  let fps: number | null = null;
  if (v?.avg_frame_rate && v.avg_frame_rate !== "0/0") {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (d) fps = n / d;
  }
  const dur = Number(j.format?.duration ?? v?.duration ?? NaN);
  return {
    durationSec: Number.isFinite(dur) ? dur : null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps,
    vCodec: v?.codec_name ?? null,
    aCodec: a?.codec_name ?? null,
    bytes: fs.statSync(file).size,
  };
}

async function runOne(c: Candidate) {
  const started = Date.now();
  const outPath = path.join(OUT_DIR, `${c.id}.mp4`);
  const log = (msg: string) => console.log(`[bakeoff] ${c.id}: ${msg}`);
  log(`inspect ${c.slug}`);
  const info = await inspectVideoModel(c.slug);
  const snapped = snapDuration(REQUESTED_SEC, info.durations);
  log(
    `catalog durations=${JSON.stringify(info.durations)} 1080p=${info.supports1080p} i2v=${info.supportsI2v} snapped=${snapped}s (${c.note})`,
  );
  if (info.supportsI2v === false) {
    throw new Error(`${c.slug} does not support I2V`);
  }
  await generateVideo({
    model: c.slug,
    prompt: MOTION,
    aspectRatio: "16:9",
    duration: REQUESTED_SEC,
    firstFramePath: KEYFRAME,
    outPath,
    resolution: c.resolution,
    onStatus: log,
  });
  const probe = probeFile(outPath);
  const row = {
    id: c.id,
    slug: c.slug,
    requestedSec: REQUESTED_SEC,
    catalogDurations: info.durations,
    snappedSec: snapped,
    resolutionRequested: c.resolution,
    note: c.note,
    elapsedMs: Date.now() - started,
    outPath,
    probe,
    error: null as string | null,
  };
  log(
    `done ${probe.width}x${probe.height} ${probe.durationSec?.toFixed(2)}s audio=${probe.aCodec ?? "none"} ${(probe.bytes / 1e6).toFixed(1)}MB`,
  );
  return row;
}

async function main() {
  if (!fs.existsSync(KEYFRAME)) {
    throw new Error(`Missing keyframe: ${KEYFRAME}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(KEYFRAME, path.join(OUT_DIR, "source_keyframe.png"));
  fs.writeFileSync(
    path.join(OUT_DIR, "prompt.txt"),
    `source: sess_anime_3716eae0 shot 0\naspect: 16:9\nrequested: ${REQUESTED_SEC}s\n\n${MOTION}\n`,
  );
  console.log(`[bakeoff] output ${OUT_DIR}`);
  console.log(`[bakeoff] 5 jobs in parallel. Veo Lite/Fast will snap to 8s. Est. API ~$5.`);

  const settled = await Promise.allSettled(CANDIDATES.map(runOne));
  const rows = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const c = CANDIDATES[i];
    const err = s.reason instanceof Error ? s.reason.message : String(s.reason);
    console.error(`[bakeoff] ${c.id}: failed ${err}`);
    return {
      id: c.id,
      slug: c.slug,
      requestedSec: REQUESTED_SEC,
      catalogDurations: [] as number[],
      snappedSec: null as number | null,
      resolutionRequested: c.resolution,
      note: c.note,
      elapsedMs: 0,
      outPath: path.join(OUT_DIR, `${c.id}.mp4`),
      probe: null,
      error: err,
    };
  });
  const report = {
    at: new Date().toISOString(),
    sourceSession: "sess_anime_3716eae0",
    shot: 0,
    keyframe: KEYFRAME,
    prompt: MOTION,
    requestedSec: REQUESTED_SEC,
    rows,
  };
  const reportPath = path.join(OUT_DIR, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[bakeoff] report ${reportPath}`);
  for (const r of rows) {
    const status = r.error ? `FAIL ${r.error.slice(0, 180)}` : "ok";
    console.log(`[bakeoff] ${r.id} ${status}`);
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
