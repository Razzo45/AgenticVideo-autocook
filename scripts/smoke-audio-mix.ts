/**
 * Offline smoke: mixAudioMaster with synthetic tones (no Gemini bill).
 * Usage: npx tsx scripts/smoke-audio-mix.ts
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mixAudioMaster, probeFile } from "../src/pipeline/stitch";
import { audioPlanSchema } from "../src/pipeline/schema";
import { durationBounds } from "../src/pipeline/constants";

const execFileAsync = promisify(execFile);
const dir = path.join("runs", "_smoke_audio");
fs.mkdirSync(dir, { recursive: true });

async function tone(out: string, freq: number, sec: number) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:sample_rate=48000:duration=${sec}`,
      "-ac",
      "2",
      out,
    ],
    { windowsHide: true },
  );
}

async function main() {
  const bounds = durationBounds("audio");
  if (bounds.min !== 15 || bounds.max !== 180) throw new Error("audio bounds wrong");

  const plan = audioPlanSchema.parse({
    media_desc: "smoke",
    target_duration: 8,
    music: { prompt: "low drone", instrumental: true },
    cues: [
      { index: 0, kind: "speech", start: 0.5, end: 3, text: "Hello from the smoke test." },
      { index: 1, kind: "speech", start: 4, end: 7, text: "Second line." },
    ],
  });

  const s0 = path.join(dir, "s0.wav");
  const s1 = path.join(dir, "s1.wav");
  const music = path.join(dir, "music.wav");
  const out = path.join(dir, "final.m4a");
  await tone(s0, 440, 2);
  await tone(s1, 520, 2);
  await tone(music, 110, 8);

  await mixAudioMaster({
    speech: [
      { path: s0, start: plan.cues[0]!.start },
      { path: s1, start: plan.cues[1]!.start },
    ],
    musicPath: music,
    duration: plan.target_duration,
    output: out,
  });

  const probe = await probeFile(out);
  console.log(
    JSON.stringify(
      {
        ok: true,
        out,
        duration: probe.duration,
        hasAudio: probe.hasAudio,
        size: fs.statSync(out).size,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
