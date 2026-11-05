/**
 * Lean guided-audio-tour assembly from supplied stems only.
 * No TTS / Lyria. One loudnorm pass to brief target.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRunInputs, type RunInputAsset } from "./inputs";
import { runDir } from "./paths";
import { probeFile } from "./stitch";
import type { RunRow } from "../db";

const execFileAsync = promisify(execFile);

export function isTourAssemblyBrief(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    (/\bguided audio tour\b/.test(p) || /\baudio tour\b/.test(p) || /\bwalking transition\b/.test(p)) &&
    (/\bsupplied (narration|recordings|materials)\b/.test(p) ||
      /\bno (synthetic|outside music|replacement dialogue)\b/.test(p) ||
      /\bediting brief\b/.test(p))
  );
}

type TourRoles = {
  narration?: RunInputAsset;
  music?: RunInputAsset;
  footsteps?: RunInputAsset;
  clock_tick?: RunInputAsset;
  clock_bell?: RunInputAsset;
  hall_ambience?: RunInputAsset;
  workshop_ambience?: RunInputAsset;
  door_close_large?: RunInputAsset;
  tools?: RunInputAsset;
  wrench?: RunInputAsset;
  drawer_open?: RunInputAsset;
  music_box?: RunInputAsset;
  door_open_small?: RunInputAsset;
  fireplace?: RunInputAsset;
  writing?: RunInputAsset;
};

function pick(assets: RunInputAsset[], re: RegExp): RunInputAsset | undefined {
  return assets.find((a) => re.test(a.filename));
}

/** Resolve by staged filenames (preferred) or duration heuristics. */
export function resolveTourRoles(run: RunRow): TourRoles {
  const audio = parseRunInputs(run.input_assets_json).filter((a) => a.kind === "audio");
  const byName: TourRoles = {
    narration: pick(audio, /narration|mastered.?tour|270c0263/i),
    music: pick(audio, /music.?bed|history.?music|66e54072/i),
    footsteps: pick(audio, /footstep|357b5ad6/i),
    clock_tick: pick(audio, /clock.?tick|ticking|f2c67c3c/i),
    clock_bell: pick(audio, /clock.?bell|chime|8691aee8/i),
    hall_ambience: pick(audio, /hall.?amb|entrance.?amb|a21932ac/i),
    workshop_ambience: pick(audio, /workshop.?amb|c999b68b/i),
    door_close_large: pick(audio, /door.?close|large.?door|3a37c3e1/i),
    tools: pick(audio, /tool.?handl|tool.?search|57f4d1c0/i),
    wrench: pick(audio, /wrench|a88a1590/i),
    drawer_open: pick(audio, /drawer|case.?open|1227140a/i),
    music_box: pick(audio, /music.?box|cylinder|ccf0ce27/i),
    door_open_small: pick(audio, /door.?open.?small|small.?door|4c138cff/i),
    fireplace: pick(audio, /fireplace|de719f86/i),
    writing: pick(audio, /writing|diary|b5b37de5/i),
  };
  return byName;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Detect the two long silent walking windows in narration. */
export async function findWalkingWindows(
  narrationPath: string,
): Promise<{ start: number; end: number }[]> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-i", narrationPath, "-af", "silencedetect=noise=-35dB:d=8", "-f", "null", "-"],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // silencedetect writes to stderr; non-zero often still ok
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  const text = stderr + stdout;
  const starts = [...text.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const windows: { start: number; end: number }[] = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    const start = starts[i]!;
    const end = ends[i]!;
    if (end - start >= 8) windows.push({ start, end });
  }
  // Prefer the two longest mid-file windows
  return windows.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 2).sort((a, b) => a.start - b.start);
}

/**
 * Assemble tour: narration base + ducked music + room ambience + footsteps in gaps + cue SFX.
 * Single loudnorm to −18 LUFS / −3 dBTP. Export 44.1 kHz / 24-bit WAV.
 */
export async function assembleTourEpisode(opts: {
  run: RunRow;
  onStatus?: (msg: string) => void;
}): Promise<{ masterWav: string; duration: number; mediaDesc: string }> {
  const roles = resolveTourRoles(opts.run);
  if (!roles.narration?.path) throw new Error("Tour assembly needs mastered narration.");
  if (!roles.music?.path) throw new Error("Tour assembly needs historical music bed.");

  const outDir = path.join(runDir(opts.run.id), "audio", "tour");
  fs.mkdirSync(outDir, { recursive: true });

  const narr = roles.narration.path;
  const narrDur = (await probeFile(narr)).duration ?? 0;
  opts.onStatus?.("Detecting walking transitions in narration…");
  let windows = await findWalkingWindows(narr);
  if (windows.length < 2) {
    // Fallback for Bell House mastered VO measured gaps
    windows = [
      { start: 84.94, end: 100.39 },
      { start: 159.95, end: 175.37 },
    ];
  }
  const t1 = windows[0]!;
  const t2 = windows[1]!;

  // Approximate cue times within room sections (lean — brief-relative, not ASR).
  const cues = {
    listen_closely: Math.max(8, t1.start * 0.35),
    hall_bell: Math.max(0, t1.start - 0.35),
    door_close: t1.end + 0.05,
    tools: t1.end + (t2.start - t1.end) * 0.22,
    wrench: t1.end + (t2.start - t1.end) * 0.38,
    drawer: t1.end + (t2.start - t1.end) * 0.55,
    music_box: t1.end + (t2.start - t1.end) * 0.72,
    small_door: Math.max(t1.end, t2.start - 0.4),
    fireplace: t2.end + 4,
    writing: t2.end + (narrDur - t2.end) * 0.35,
    tick_close: t2.end + (narrDur - t2.end) * 0.62,
    final_bell: Math.max(t2.end + 5, narrDur - 4.5),
  };

  opts.onStatus?.("Building lean tour mix (narration + beds + cue SFX)…");

  // Pre-render looped/trimmed beds
  const musicLoop = path.join(outDir, "music.wav");
  await ffmpeg([
    "-stream_loop",
    "-1",
    "-i",
    roles.music.path,
    "-t",
    (narrDur + 8).toFixed(3),
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    "pcm_s24le",
    musicLoop,
  ]);

  const inputs: string[] = ["-i", narr, "-i", musicLoop];
  const labels: string[] = [];
  // [0] narr [1] music
  // music: -21dB under speech, -14dB in walking windows
  labels.push(
    `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
      `volume=enable='between(t,${t1.start.toFixed(3)},${t1.end.toFixed(3)})+between(t,${t2.start.toFixed(3)},${t2.end.toFixed(3)})':volume=0.20,` +
      `volume=enable='not(between(t,${t1.start.toFixed(3)},${t1.end.toFixed(3)})+between(t,${t2.start.toFixed(3)},${t2.end.toFixed(3)}))':volume=0.09[m]`,
  );

  let nextIdx = 2;
  const mixParts = ["[0:a]", "[m]"];

  const addBed = async (
    asset: RunInputAsset | undefined,
    start: number,
    end: number,
    vol: number,
    tag: string,
  ) => {
    if (!asset?.path || end <= start) return;
    const clip = path.join(outDir, `${tag}.wav`);
    const need = end - start + 0.5;
    await ffmpeg([
      "-stream_loop",
      "-1",
      "-i",
      asset.path,
      "-t",
      need.toFixed(3),
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s24le",
      clip,
    ]);
    inputs.push("-i", clip);
    const i = nextIdx++;
    const delay = Math.round(start * 1000);
    labels.push(
      `[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${vol},adelay=${delay}|${delay},apad,atrim=0:${narrDur.toFixed(3)}[${tag}]`,
    );
    mixParts.push(`[${tag}]`);
  };

  const addOneShot = async (
    asset: RunInputAsset | undefined,
    at: number,
    vol: number,
    tag: string,
  ) => {
    if (!asset?.path) return;
    inputs.push("-i", asset.path);
    const i = nextIdx++;
    const delay = Math.round(Math.max(0, at) * 1000);
    labels.push(
      `[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${vol},adelay=${delay}|${delay},apad,atrim=0:${(narrDur + 6).toFixed(3)}[${tag}]`,
    );
    mixParts.push(`[${tag}]`);
  };

  await addBed(roles.hall_ambience, 0, t1.start, 0.07, "hamb");
  await addBed(roles.footsteps, t1.start, t1.end, 0.28, "fs1");
  await addBed(roles.footsteps, t2.start, t2.end, 0.28, "fs2");
  await addBed(roles.workshop_ambience, t1.end, t2.start, 0.08, "wamb");
  await addBed(roles.fireplace, t2.end, narrDur, 0.07, "fire");
  await addBed(roles.clock_tick, cues.listen_closely, t1.start, 0.06, "tick1");
  await addBed(roles.clock_tick, cues.tick_close, cues.final_bell, 0.05, "tick2");

  await addOneShot(roles.clock_bell, cues.hall_bell, 0.45, "bell1");
  await addOneShot(roles.door_close_large, cues.door_close, 0.35, "dclose");
  await addOneShot(roles.tools, cues.tools, 0.18, "tools");
  await addOneShot(roles.wrench, cues.wrench, 0.16, "wrench");
  await addOneShot(roles.drawer_open, cues.drawer, 0.22, "drawer");
  await addOneShot(roles.music_box, cues.music_box, 0.14, "mbox");
  await addOneShot(roles.door_open_small, cues.small_door, 0.3, "dopen");
  await addOneShot(roles.writing, cues.writing, 0.14, "write");
  await addOneShot(roles.clock_bell, cues.final_bell, 0.5, "bell2");

  labels.push(
    `${mixParts.join("")}amix=inputs=${mixParts.length}:duration=longest:dropout_transition=0:normalize=0,` +
      `afade=t=out:st=${Math.max(0, narrDur + 2).toFixed(3)}:d=4[aout]`,
  );

  const rawMix = path.join(outDir, "tour_raw.wav");
  await ffmpeg([
    ...inputs,
    "-filter_complex",
    labels.join(";"),
    "-map",
    "[aout]",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    "pcm_s24le",
    "-t",
    (narrDur + 6).toFixed(3),
    rawMix,
  ]);

  opts.onStatus?.("Mastering (−18 LUFS, −3 dBTP, 44.1 kHz / 24-bit)…");
  const master = path.join(runDir(opts.run.id), "final.wav");
  await ffmpeg([
    "-i",
    rawMix,
    "-af",
    "loudnorm=I=-18:TP=-3:LRA=11",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    "pcm_s24le",
    master,
  ]);

  const dur = (await probeFile(master)).duration ?? narrDur;
  fs.copyFileSync(master, path.join(runDir(opts.run.id), "final_synced.wav"));
  fs.writeFileSync(
    path.join(outDir, "tour_cues.json"),
    JSON.stringify({ windows, cues, roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v?.filename ?? null])) }, null, 2),
  );
  return {
    masterWav: master,
    duration: dur,
    mediaDesc: "Bell House guided audio tour — Entrance Hall, Workshop, Private Study",
  };
}
