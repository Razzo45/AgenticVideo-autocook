import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CONTINUATION_TRIM_SEC, STITCH_FPS, type OutputResolution, type VideoAspect, dimensionsForAspect } from "./constants";

const execFileAsync = promisify(execFile);
const FF_OPTS = { maxBuffer: 32 * 1024 * 1024, windowsHide: true as const };

function ffmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", ...args], FF_OPTS);
}

function ffprobe(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("ffprobe", args, FF_OPTS);
}

export type Probe = {
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  codec: string | null;
  format: string;
  bitrate: number | null;
  pixFmt: string | null;
  hasAudio: boolean;
  crop: { w: number; h: number } | null;
};

function parseFps(rate: string | undefined): number | null {
  if (!rate || rate === "0/0") return null;
  if (rate.includes("/")) {
    const [a, b] = rate.split("/").map(Number);
    if (!b) return null;
    return Math.round((a / b) * 1000) / 1000;
  }
  const n = Number(rate);
  return Number.isFinite(n) ? n : null;
}

export async function probeFile(filePath: string): Promise<Probe> {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const info = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      pix_fmt?: string;
    }>;
  };
  const video = info.streams?.find((s) => s.codec_type === "video");
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  const ext = path.extname(filePath).replace(".", "").toLowerCase();
  const videoDur = video?.duration ? Number(video.duration) : null;
  const duration = Number.isFinite(videoDur)
    ? videoDur
    : info.format?.duration
      ? Number(info.format.duration)
      : null;
  const bitrate = info.format?.bit_rate ? Number(info.format.bit_rate) : null;
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number.isFinite(duration) ? duration : null,
    fps: parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate),
    codec: video?.codec_name ?? null,
    format: ext || (info.format?.format_name?.split(",")[0] ?? "unknown"),
    bitrate: Number.isFinite(bitrate) ? bitrate : null,
    pixFmt: video?.pix_fmt ?? null,
    hasAudio: Boolean(audio),
    crop: null,
  };
}

export async function detectBlackBars(filePath: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stderr } = await ffmpeg([
      "-i",
      filePath,
      "-t",
      "2",
      "-vf",
      "cropdetect=12:16:0",
      "-f",
      "null",
      "-",
    ]);
    const matches = [...String(stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1];
    return { w: Number(last[1]), h: Number(last[2]) };
  } catch {
    return null;
  }
}

export async function extractFirstFrame(videoPath: string, outPng: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await ffmpeg(["-y", "-i", videoPath, "-frames:v", "1", "-update", "1", outPng]);
}

/**
 * Turn a still into an H.264 clip (looped hold) so auto cooks can continue after Veo empty-filters.
 */
export async function stillHoldFromImage(
  imagePath: string,
  outMp4: string,
  durationSec: number,
  opts?: { fps?: number },
): Promise<void> {
  if (!fs.existsSync(imagePath)) throw new Error(`stillHold source missing: ${imagePath}`);
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  const dur = Math.max(1, Math.min(30, durationSec || 8));
  const fps = opts?.fps ?? STITCH_FPS;
  await ffmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-t",
    dur.toFixed(3),
    "-r",
    String(fps),
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outMp4,
  ]);
  if (!fs.existsSync(outMp4) || fs.statSync(outMp4).size < 1024) {
    throw new Error(`stillHoldFromImage failed to write ${outMp4}`);
  }
}

/** Grab a still at an absolute timestamp (seconds). Accurate enough for plate keyframes. */
export async function extractFrameAtSec(videoPath: string, timeSec: number, outPng: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const t = Math.max(0, timeSec);
  await ffmpeg([
    "-y",
    "-ss",
    t.toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-update",
    "1",
    outPng,
  ]);
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size < 64) {
    throw new Error(`Could not extract frame at ${t.toFixed(3)}s from ${path.basename(videoPath)}`);
  }
}

/** Exact last frame, scaled to a keyframe canvas (no crop — preserves join framing). */
export async function extractLastFrameKeyframe(
  videoPath: string,
  outPng: string,
  width: number,
  height: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const tmp = `${outPng}.raw.png`;
  await extractLastFrame(videoPath, tmp);
  try {
    await ffmpeg([
      "-y",
      "-i",
      tmp,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      "-frames:v",
      "1",
      "-update",
      "1",
      outPng,
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size < 64) {
    throw new Error(`Could not build join keyframe from ${path.basename(videoPath)}`);
  }
}

export async function extractLastFrame(videoPath: string, outStill: string): Promise<void> {
  fs.mkdirSync(path.dirname(outStill), { recursive: true });
  const jpeg = /\.jpe?g$/i.test(outStill);
  const encode = jpeg
    ? ["-vf", "scale=1920:1920:force_original_aspect_ratio=decrease", "-q:v", "3"]
    : ["-frames:v", "1", "-update", "1"];
  const head = (seek: string[]): string[] => [
    "-y",
    ...seek,
    "-i",
    videoPath,
    "-an",
    ...(jpeg ? ["-frames:v", "1", "-update", "1"] : []),
    ...encode,
    outStill,
  ];
  const attempts: string[][] = [head(["-sseof", "-0.12"]), head(["-sseof", "-0.5"])];
  const probe = await probeFile(videoPath);
  const fps = probe.fps && probe.fps > 1 ? probe.fps : 24;
  const dur = probe.duration ?? 0;
  if (dur > 0) {
    attempts.push(head(["-ss", Math.max(0, dur - 2 / fps).toFixed(3)]));
  }
  let lastErr: Error | null = null;
  for (const args of attempts) {
    try {
      await ffmpeg(args);
      if (fs.existsSync(outStill) && fs.statSync(outStill).size > 64) return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error(`Could not grab a still from ${path.basename(videoPath)}`);
}

/** Re-encode a clip for V2V upload (HTTPS hosts + provider size limits). */
export async function compressVideoForUpload(
  src: string,
  dest: string,
  maxMb = 12,
  /** Hard cap so multi-GB plates never get fully re-encoded. */
  maxSec = 16,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(src)) throw new Error(`Missing source for upload compress: ${src}`);
  const size = fs.statSync(src).size;
  const huge = size > maxMb * 1024 * 1024;
  const crf = huge ? "28" : "23";
  const t = String(Math.max(2, maxSec));
  // Always bound duration; put -ss/-t before -i so ffmpeg can skip demuxing the rest of huge plates.
  await ffmpeg([
    "-y",
    "-ss",
    "0",
    "-t",
    t,
    "-i",
    src,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    crf,
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale='min(1280,iw)':-2",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    dest,
  ]);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
    throw new Error(`Failed to compress ${path.basename(src)} for upload`);
  }
}

/** Force edit output to the exact pixel size of the source take (providers often downscale). */
export async function scaleVideoToSize(src: string, dest: string, width: number, height: number): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round(height / 2) * 2);
  await ffmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    `scale=${w}:${h}:flags=lanczos`,
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    dest,
  ]);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
    throw new Error(`Failed to scale ${path.basename(src)} to ${w}x${h}`);
  }
}

/** Smaller JPEG for OpenRouter input_references. Original files stay on disk. */
export async function encodeReferenceStill(src: string, destJpeg: string, maxEdge = 1920): Promise<void> {
  if (!fs.existsSync(src)) {
    throw new Error(`Reference still is missing: ${src}`);
  }
  fs.mkdirSync(path.dirname(destJpeg), { recursive: true });
  await ffmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease`,
    "-q:v",
    "3",
    destJpeg,
  ]);
}

/** 21:9 (~2.33) → 2.35:1 crop to session delivery resolution. */
export async function cropVideoToCinemascope(
  src: string,
  dest: string,
  outputResolution: OutputResolution = "1080p",
): Promise<void> {
  const { width, height } = dimensionsForAspect("2.35:1", outputResolution);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await ffmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    `crop=iw:trunc(iw/2.35/2)*2,scale=${width}:${height}:flags=lanczos,fps=30,format=yuv420p`,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    dest,
  ]);
}

export async function extractAudio(videoPath: string, outAac: string): Promise<boolean> {
  const probe = await probeFile(videoPath);
  if (!probe.hasAudio) return false;
  fs.mkdirSync(path.dirname(outAac), { recursive: true });
  await ffmpeg(["-y", "-i", videoPath, "-vn", "-c:a", "aac", "-b:a", "192k", outAac]);
  return true;
}

/**
 * Pull a few stills from an operator reference MP4 so models that only honor image
 * input_references (e.g. Veo) still see the brand plate / motion look.
 */
export async function extractVideoReferenceStills(
  videoPath: string,
  outDir: string,
  opts?: { maxStills?: number },
): Promise<string[]> {
  if (!fs.existsSync(videoPath)) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const probe = await probeFile(videoPath);
  const dur = Math.max(0.1, probe.duration ?? 1);
  const max = Math.max(1, Math.min(opts?.maxStills ?? 3, 6));
  const stamps =
    max === 1
      ? [Math.min(0.35, dur * 0.15)]
      : Array.from({ length: max }, (_, i) => {
          // Bias slightly earlier — faces/action often land before mid-clip B-roll.
          const t = dur * (0.12 + (0.7 * i) / Math.max(1, max - 1));
          return Math.min(dur - 0.05, Math.max(0.05, t));
        });
  const stem = path.basename(videoPath, path.extname(videoPath)).replace(/[^\w.-]+/g, "_").slice(0, 40);
  const existing = Array.from({ length: max }, (_, i) => path.join(outDir, `${stem}_t${i}.jpg`)).filter(
    (p) => fs.existsSync(p) && fs.statSync(p).size > 64,
  );
  if (existing.length >= max) return existing.slice(0, max);

  const out: string[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const dest = path.join(outDir, `${stem}_t${i}.jpg`);
    try {
      await ffmpeg([
        "-y",
        "-ss",
        String(Math.max(0, stamps[i]!)),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        dest,
      ]);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 64) out.push(dest);
    } catch (err) {
      console.warn(`[refs] failed frame extract from ${path.basename(videoPath)}:`, err);
    }
  }
  return out;
}

function scaleFilter(
  aspect: VideoAspect,
  outputResolution: OutputResolution = "1080p",
  fps: string | number = STITCH_FPS,
): string {
  const { width, height } = dimensionsForAspect(aspect, outputResolution);
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`;
}

export async function normalizeClip(
  input: string,
  output: string,
  aspect: VideoAspect,
  opts?: { trimStart?: number; outputResolution?: OutputResolution; fps?: string | number },
): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const probe = await probeFile(input);
  const args = ["-y"];
  if (opts?.trimStart && opts.trimStart > 0) args.push("-ss", String(opts.trimStart));
  args.push("-i", input);
  if (!probe.hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }
  args.push(
    "-vf",
    scaleFilter(aspect, opts?.outputResolution ?? "1080p", opts?.fps),
    "-map",
    "0:v:0",
    "-map",
    probe.hasAudio ? "0:a:0" : "1:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  );
  await ffmpeg(args);
}

/**
 * Supplied-footage insert: picture from `source` (start..end, held on its last frame if short),
 * audio from the generated `audioClip`, cut to the clip's duration.
 */
export async function buildInsertClip(opts: {
  source: string;
  start: number;
  end?: number;
  audioClip: string;
  output: string;
}): Promise<void> {
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const [src, clip] = await Promise.all([probeFile(opts.source), probeFile(opts.audioClip)]);
  const clipDur = clip.duration ?? 8;
  const srcDur = src.duration ?? 0;
  const start = Math.min(Math.max(0, opts.start), Math.max(0, srcDur - 0.5));
  const wanted = opts.end && opts.end > start ? opts.end - start : clipDur;
  const seg = Math.max(0.2, Math.min(wanted, clipDur, srcDur - start));
  const hold = Math.max(0, clipDur - seg);
  const args = ["-y", "-ss", start.toFixed(3), "-t", seg.toFixed(3), "-i", opts.source, "-i", opts.audioClip];
  args.push(
    "-filter_complex",
    `[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p[v]`,
    "-map",
    "[v]",
  );
  if (clip.hasAudio) args.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "192k");
  args.push(
    "-t",
    clipDur.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-movflags",
    "+faststart",
    opts.output,
  );
  await ffmpeg(args);
  if (!fs.existsSync(opts.output) || fs.statSync(opts.output).size < 1024) {
    throw new Error(`Insert build failed for ${path.basename(opts.source)}`);
  }
}

/**
 * Lay a music bed under the stitched dialogue: looped to length, sidechain-ducked by the
 * dialogue, faded out, loudness-normalised. Video is stream-copied.
 */
/** Volume expression that is 1 inside the windows and ramps over `ramp` seconds at interior edges. */
function musicGateExpr(windows: Array<{ start: number; end: number }>, dur: number, ramp = 1.5): string {
  const terms = windows
    .map((w) => ({ a: Math.max(0, w.start), b: Math.min(dur, w.end) }))
    .filter((w) => w.b - w.a > 0.1)
    .map(({ a, b }) => {
      const rise = a <= 0.01 ? "1" : `min(1,max(0,(t-${a.toFixed(3)})/${ramp}))`;
      const fall = b >= dur - 0.01 ? "1" : `min(1,max(0,(${b.toFixed(3)}-t)/${ramp}))`;
      return `${rise}*${fall}`;
    });
  return terms.length ? terms.join("+") : "0";
}

export async function mixMusicBed(opts: {
  video: string;
  music: string;
  output: string;
  /** Timeline spans (seconds) where the bed plays; omitted = whole edit. */
  windows?: Array<{ start: number; end: number }>;
}): Promise<void> {
  const dur = (await probeFile(opts.video)).duration ?? 0;
  if (dur <= 0) throw new Error("mixMusicBed: stitched video has no duration");
  const fade = Math.min(3, dur / 4);
  const gate = opts.windows ? `,volume='${musicGateExpr(opts.windows, dur)}':eval=frame` : "";
  const filter = [
    "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[dia][key];",
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.22${gate}[bed];`,
    "[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[duck];",
    "[dia][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,",
    `afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
  ].join("");
  await ffmpeg([
    "-y",
    "-i",
    opts.video,
    "-stream_loop",
    "-1",
    "-i",
    opts.music,
    "-filter_complex",
    filter,
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    dur.toFixed(3),
    "-movflags",
    "+faststart",
    opts.output,
  ]);
  if (!fs.existsSync(opts.output) || fs.statSync(opts.output).size < 1024) {
    throw new Error("mixMusicBed produced empty output");
  }
}

/**
 * Audio-only master: place TTS clips on a timeline over one music bed.
 * Intentionally raw — no loudnorm, no sidechain duck, no cinematic fades.
 * Models stay audible as generated; ffmpeg only times and overlays.
 */
export async function mixAudioMaster(opts: {
  /** Speech files with timeline start (seconds). */
  speech: Array<{ path: string; start: number }>;
  musicPath: string | null;
  duration: number;
  output: string;
}): Promise<void> {
  const dur = Math.max(1, opts.duration);
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const speech = opts.speech.filter((s) => s.path && fs.existsSync(s.path));
  const hasMusic = Boolean(opts.musicPath && fs.existsSync(opts.musicPath!));
  if (!speech.length && !hasMusic) throw new Error("mixAudioMaster: no speech or music inputs");

  const args: string[] = ["-y"];
  // Silent base so the timeline always fills to `dur` even if speech is short.
  args.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
  for (const clip of speech) args.push("-i", clip.path);
  if (hasMusic) args.push("-stream_loop", "-1", "-i", opts.musicPath!);

  const filterParts: string[] = [];
  const mixLabels: string[] = ["[0:a]"];
  for (let i = 0; i < speech.length; i++) {
    const delayMs = Math.max(0, Math.round(speech[i]!.start * 1000));
    filterParts.push(
      `[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`,
    );
    mixLabels.push(`[s${i}]`);
  }
  if (hasMusic) {
    const idx = 1 + speech.length;
    // Slight dip only so speech isn't buried — not a polished duck chain.
    filterParts.push(
      `[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.55,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[m0]`,
    );
    mixLabels.push("[m0]");
  }
  filterParts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`,
  );

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    dur.toFixed(3),
    "-movflags",
    "+faststart",
    opts.output,
  );
  await ffmpeg(args);
  if (!fs.existsSync(opts.output) || fs.statSync(opts.output).size < 1024) {
    throw new Error("mixAudioMaster produced empty output");
  }
}

/** First `duration` seconds of a clip, re-encoded so the cut is frame-exact, with the audio faded out. */
export async function trimClip(input: string, output: string, duration: number): Promise<void> {
  const d = duration.toFixed(3);
  await ffmpeg([
    "-y",
    "-i",
    input,
    "-t",
    d,
    "-af",
    `afade=t=out:st=${Math.max(0, duration - 0.4).toFixed(3)}:d=0.4`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    output,
  ]);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) throw new Error("trimClip produced empty output");
}

/** A still held for `duration` seconds with a silent stereo track (stitch expects audio on every clip). */
export async function stillToClip(image: string, output: string, duration: number): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await ffmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    image,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    duration.toFixed(3),
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    output,
  ]);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) throw new Error("stillToClip produced empty output");
}

/** Crop (w:h:x:y) of a logo PNG's visible pixels, so padding doesn't shrink the bug. */
async function logoBounds(png: string): Promise<string | null> {
  const { stderr } = await ffmpeg([
    "-i",
    png,
    "-vf",
    "alphaextract,cropdetect=limit=24:round=2:reset=0",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const m = [...stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)].pop();
  return m ? m[1] : null;
}

/** Mean luma (0–255) of the top-right corner at time t. */
async function cornerLuma(video: string, t: number): Promise<number> {
  const { stderr } = await ffmpeg([
    "-ss",
    t.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    "crop=iw*0.16:ih*0.14:iw*0.82:ih*0.03,signalstats,metadata=print",
    "-f",
    "null",
    "-",
  ]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const m = stderr.match(/YAVG=([\d.]+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Composite the supplied logo small in the top-right corner over the given time windows.
 * Each window uses the light logo over a dark corner and the dark logo over a light one.
 */
/** ffmpeg filter-option path: forward slashes, escaped drive colon. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

const CALLOUT_FONTS = ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"];

export async function overlayLogoBug(opts: {
  video: string;
  output: string;
  windows: Array<{ start: number; end: number }>;
  light?: string;
  dark?: string;
  /** Short pop-up text boxes, lower centre, faded in and out. */
  callouts?: Array<{ start: number; end: number; text: string }>;
  calloutColor?: string;
  fontFile?: string;
}): Promise<void> {
  const probe = await probeFile(opts.video);
  const dur = probe.duration ?? 0;
  const logos = [opts.light, opts.dark].filter((p): p is string => Boolean(p && fs.existsSync(p)));
  const callouts = (opts.callouts ?? []).filter((c) => c.text.trim() && c.end - c.start > 0.5);
  if ((!logos.length || !opts.windows.length) && !callouts.length) {
    fs.copyFileSync(opts.video, opts.output);
    return;
  }
  if (dur <= 0) {
    fs.copyFileSync(opts.video, opts.output);
    return;
  }
  const byLogo = new Map<string, string[]>();
  for (const w of logos.length ? opts.windows : []) {
    const a = Math.max(0, w.start);
    const b = Math.min(dur, w.end);
    if (b - a < 0.2) continue;
    const luma = await cornerLuma(opts.video, (a + b) / 2);
    const pick = (luma < 128 ? opts.light : opts.dark) ?? logos[0];
    byLogo.set(pick, [...(byLogo.get(pick) ?? []), `between(t,${a.toFixed(3)},${b.toFixed(3)})`]);
  }
  const logoW = Math.round(probe.width * 0.09 / 2) * 2;
  const marginX = Math.round(probe.width * 0.045);
  const marginY = Math.round(probe.height * 0.05);
  const inputs: string[] = ["-i", opts.video];
  const chains: string[] = [];
  let last = "[0:v]";
  let n = 0;
  for (const [logo, spans] of byLogo) {
    n += 1;
    inputs.push("-i", logo);
    const crop = await logoBounds(logo);
    chains.push(
      `[${n}:v]${crop ? `crop=${crop},` : ""}scale=${logoW}:-2,format=rgba,colorchannelmixer=aa=0.8[l${n}]`,
      `${last}[l${n}]overlay=x=W-w-${marginX}:y=${marginY}:enable='${spans.join("+")}'[v${n}]`,
    );
    last = `[v${n}]`;
  }
  if (callouts.length) {
    const font = [opts.fontFile, ...CALLOUT_FONTS].find((f) => f && fs.existsSync(f));
    const box = /^#?[0-9a-f]{6}$/i.test(opts.calloutColor ?? "") ? `0x${opts.calloutColor!.replace("#", "")}` : "0x111111";
    const textDir = path.join(path.dirname(opts.output), "callouts");
    fs.mkdirSync(textDir, { recursive: true });
    const size = Math.round(probe.height * 0.042);
    const pad = Math.round(probe.height * 0.022);
    const wrapCallout = (raw: string): string => {
      const words = raw.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return "";
      const maxChars = Math.max(12, Math.floor(probe.width / Math.max(8, size * 0.55)));
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (next.length > maxChars && line) {
          lines.push(line);
          line = w;
        } else {
          line = next;
        }
      }
      if (line) lines.push(line);
      return lines.join("\n");
    };
    const parts = callouts.map((c, i) => {
      const txt = path.join(textDir, `c${i}.txt`);
      fs.writeFileSync(txt, wrapCallout(c.text), "utf8");
      const a = Math.max(0, c.start).toFixed(3);
      const b = Math.min(dur, c.end).toFixed(3);
      const fade = `if(lt(t,${a}+0.35),(t-${a})/0.35,if(gt(t,${b}-0.35),(${b}-t)/0.35,1))`;
      return [
        `drawtext=textfile='${filterPath(txt)}'`,
        font ? `fontfile='${filterPath(font)}'` : "",
        `fontsize=${size}`,
        "fontcolor=white",
        "box=1",
        `boxcolor=${box}@0.88`,
        `boxborderw=${pad}`,
        "x=(w-text_w)/2",
        "y=h*0.78-text_h/2",
        `alpha='${fade}'`,
        `enable='between(t,${a},${b})'`,
      ]
        .filter(Boolean)
        .join(":");
    });
    n += 1;
    chains.push(`${last}${parts.join(",")}[v${n}]`);
    last = `[v${n}]`;
  }
  if (!n) {
    fs.copyFileSync(opts.video, opts.output);
    return;
  }
  await ffmpeg([
    "-y",
    ...inputs,
    "-filter_complex",
    chains.join(";"),
    "-map",
    last,
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    opts.output,
  ]);
  if (!fs.existsSync(opts.output) || fs.statSync(opts.output).size < 1024) {
    throw new Error("overlayLogoBug produced empty output");
  }
}

export async function concatClips(inputs: string[], output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const listPath = output + ".txt";
  fs.writeFileSync(
    listPath,
    inputs.map((p) => `file '${p.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"),
    "utf8",
  );
  try {
    await ffmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      output,
    ]);
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

export async function stitchSession(
  clipPaths: string[],
  output: string,
  aspect: VideoAspect,
  outputResolution: OutputResolution = "1080p",
  bookends?: { head?: string[]; tail?: string[] },
  fps: string | number = STITCH_FPS,
): Promise<void> {
  const ordered = [...(bookends?.head ?? []), ...clipPaths, ...(bookends?.tail ?? [])];
  if (!ordered.length) throw new Error("No clips to stitch");
  const normalized: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const n = output.replace(/\.mp4$/i, `_norm_${i}.mp4`);
    // Only trim join seams between generated body clips — never trim operator intro/outro.
    const isBody =
      i >= (bookends?.head?.length ?? 0) && i < ordered.length - (bookends?.tail?.length ?? 0);
    const bodyIndex = i - (bookends?.head?.length ?? 0);
    await normalizeClip(ordered[i]!, n, aspect, {
      trimStart: isBody && bodyIndex > 0 ? CONTINUATION_TRIM_SEC : 0,
      outputResolution,
      fps,
    });
    normalized.push(n);
  }
  if (normalized.length === 1) {
    fs.copyFileSync(normalized[0]!, output);
    return;
  }
  await concatClips(normalized, output);
}

/**
 * Source-preserving alpha-over: plate RGB + overlay with alpha (e.g. ProRes 4444 matte).
 * Optional catchlight restore: screen bright plate luma through the overlay alpha mask.
 */
export async function overlayAlphaVideo(opts: {
  platePath: string;
  overlayPath: string;
  outPath: string;
  restoreCatchlights?: boolean;
  /** Soft luma threshold 0–255 for catchlight pull (default 190). */
  catchlightThreshold?: number;
}): Promise<void> {
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const thr = Math.max(1, Math.min(254, opts.catchlightThreshold ?? 190));
  let filter: string;
  if (opts.restoreCatchlights) {
    filter = [
      "[0:v]format=rgba,split=2[base][plate];",
      "[1:v]format=rgba,split=2[ov][ovmask];",
      "[base][ov]overlay=format=auto:shortest=1[comp];",
      `[plate]format=gray,lut=y='if(gte(val\\,${thr})\\,val\\,0)',format=rgba[hi];`,
      "[ovmask]alphaextract[mask];",
      "[hi][mask]alphamerge[sparks];",
      "[comp][sparks]overlay=format=auto:shortest=1:eof_action=pass,format=yuv420p[vout]",
    ].join("");
  } else {
    filter =
      "[0:v]format=rgba[base];[1:v]format=rgba[ov];[base][ov]overlay=format=auto:shortest=1,format=yuv420p[vout]";
  }
  await ffmpeg([
    "-y",
    "-i",
    opts.platePath,
    "-i",
    opts.overlayPath,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "15",
    "-preset",
    "medium",
    "-movflags",
    "+faststart",
    opts.outPath,
  ]);
  if (!fs.existsSync(opts.outPath) || fs.statSync(opts.outPath).size < 1024) {
    throw new Error("overlay_alpha produced empty output");
  }
}

/**
 * Gradual global saturation pull (frame-indexed). Useful when no face matte exists.
 * sat=1 before startFrame, lerps to endSat by endFrame, holds after.
 */
export async function applySaturationRamp(opts: {
  inPath: string;
  outPath: string;
  startFrame: number;
  endFrame: number;
  endSaturation?: number;
  fps?: number;
}): Promise<void> {
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const a = Math.max(0, Math.floor(opts.startFrame));
  const b = Math.max(a + 1, Math.floor(opts.endFrame));
  const endSat = Math.max(0, Math.min(1, opts.endSaturation ?? 0));
  const span = b - a;
  // hue filter s= expression uses frame number n
  const expr = `if(lt(n\\,${a})\\,1\\,if(gt(n\\,${b})\\,${endSat}\\,1-(1-${endSat})*(n-${a})/${span}))`;
  await ffmpeg([
    "-y",
    "-i",
    opts.inPath,
    "-vf",
    `hue=s='${expr}',format=yuv420p`,
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "15",
    "-preset",
    "medium",
    "-movflags",
    "+faststart",
    opts.outPath,
  ]);
  if (!fs.existsSync(opts.outPath) || fs.statSync(opts.outPath).size < 1024) {
    throw new Error("saturation_ramp produced empty output");
  }
}

export type MaskedSatMaskMode =
  | "alpha"
  | "luma"
  | "face_from_eye_alpha";

/**
 * Timed saturation pull limited to a mask region (face-isolated grade).
 * Prefer face_from_eye_alpha with a tracked eye/element alpha to cover the face
 * without desaturating the whole plate grade.
 */
export async function applyMaskedSaturationRamp(opts: {
  inPath: string;
  maskPath: string;
  outPath: string;
  startFrame: number;
  endFrame: number;
  endSaturation?: number;
  maskMode?: MaskedSatMaskMode;
  /** Dilation passes for face_from_eye_alpha (default 14). */
  dilateIterations?: number;
  /** Soft edge blur sigma (default 28). */
  blurSigma?: number;
  /** Extra downward expansion in pixels for face_from_eye_alpha (default 120). */
  expandDownPx?: number;
}): Promise<void> {
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const a = Math.max(0, Math.floor(opts.startFrame));
  const b = Math.max(a + 1, Math.floor(opts.endFrame));
  const endSat = Math.max(0, Math.min(1, opts.endSaturation ?? 0));
  const span = b - a;
  const expr = `if(lt(n\\,${a})\\,1\\,if(gt(n\\,${b})\\,${endSat}\\,1-(1-${endSat})*(n-${a})/${span}))`;
  const mode = opts.maskMode ?? "alpha";
  const dilateN = Math.max(0, Math.floor(opts.dilateIterations ?? 14));
  const blur = Math.max(0.5, opts.blurSigma ?? 28);
  const down = Math.max(0, Math.floor(opts.expandDownPx ?? 120));

  let maskChain: string;
  if (mode === "luma") {
    maskChain = `[1:v]format=gray,gblur=sigma=${blur}:steps=2[mask]`;
  } else if (mode === "face_from_eye_alpha") {
    // Expand tracked eye alpha into a soft face ROI (dilate + blur + downward lighten).
    const dilate =
      dilateN > 0
        ? [...Array(Math.min(dilateN, 24))].map(() => "dilation").join(",") + ","
        : "";
    if (down > 0) {
      maskChain = [
        `[1:v]format=rgba,alphaextract,format=gray,${dilate}gblur=sigma=${blur}:steps=2,split=2[m0][m1];`,
        `[m1]geq=lum='lum(X\\,max(0\\,Y-${down}))':cb=128:cr=128[mshift];`,
        `[m0][mshift]blend=all_mode=lighten,format=gray[mask]`,
      ].join("");
    } else {
      maskChain = `[1:v]format=rgba,alphaextract,format=gray,${dilate}gblur=sigma=${blur}:steps=2,format=gray[mask]`;
    }
  } else {
    // alpha (default)
    maskChain = `[1:v]format=rgba,alphaextract,gblur=sigma=${Math.min(blur, 8)}:steps=1,format=gray[mask]`;
  }

  const filter = [
    `[0:v]format=yuv420p,split=2[orig][gradein];`,
    `[gradein]hue=s='${expr}'[graded];`,
    `${maskChain};`,
    `[orig][graded][mask]maskedmerge,format=yuv420p[vout]`,
  ].join("");

  await ffmpeg([
    "-y",
    "-i",
    opts.inPath,
    "-i",
    opts.maskPath,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "15",
    "-preset",
    "medium",
    "-movflags",
    "+faststart",
    opts.outPath,
  ]);
  if (!fs.existsSync(opts.outPath) || fs.statSync(opts.outPath).size < 1024) {
    throw new Error("masked_saturation_ramp produced empty output");
  }
}

/** Conform to exact frame count / fps / size — source-preserving rewrap/encode. Audio stripped unless keepAudio. */
export async function conformExactDelivery(opts: {
  inPath: string;
  outPath: string;
  width: number;
  height: number;
  /** Number or ffmpeg rate string (e.g. "24", "24000/1001"). */
  fps: number | string;
  frames: number;
  /** h264 (default) or Apple ProRes 4444 (prores_ks profile 4). */
  codec?: "h264" | "prores4444";
  /** ProRes only: keep an alpha plane. Off by default — a finished composite is opaque. */
  alpha?: boolean;
  /** Keep the edit's audio (AAC), padded/trimmed to the exact frame-count duration. */
  keepAudio?: boolean;
}): Promise<void> {
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const fps = typeof opts.fps === "string" ? opts.fps : opts.fps > 0 ? String(opts.fps) : "24";
  const frames = Math.max(1, Math.floor(opts.frames));
  const codec = opts.codec ?? "h264";
  // Hold the last frame if the edit runs short, so -frames:v always lands on the exact count.
  const geometry = `fps=${fps},scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=10,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;
  const rec709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
  if (codec === "prores4444") {
    const pix = opts.alpha ? "yuva444p10le" : "yuv444p10le";
    await ffmpeg([
      "-y",
      "-i",
      opts.inPath,
      "-vf",
      `${geometry},format=${pix}`,
      "-frames:v",
      String(frames),
      "-an",
      "-dn",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      pix,
      "-vendor",
      "apl0",
      ...rec709,
      opts.outPath,
    ]);
  } else {
    // CRF 14 balloons on long 4K masters (~100 Mb/s). Cap average bitrate so a ~4 min
    // UHD silent deliverable stays under ~1.5 GB (~40 Mb/s).
    const fpsNum = Number(String(fps).split("/")[0]) || 24;
    const durationSec = frames / fpsNum;
    const longMaster = durationSec >= 90;
    const [fpsN, fpsD] = String(fps).split("/").map(Number);
    const audioArgs = opts.keepAudio
      ? ([
          "-af",
          `apad,atrim=0:${(frames / (fpsD ? fpsN! / fpsD : fpsN || 24)).toFixed(3)}`,
          "-c:a",
          "aac",
          "-b:a",
          "192k",
        ] as string[])
      : (["-an"] as string[]);
    await ffmpeg([
      "-y",
      "-i",
      opts.inPath,
      "-vf",
      `${geometry},format=yuv420p`,
      "-frames:v",
      String(frames),
      ...audioArgs,
      "-dn",
      ...rec709,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      ...(longMaster
        ? (["-b:v", "40M", "-maxrate", "45M", "-bufsize", "90M"] as string[])
        : (["-crf", "14"] as string[])),
      "-movflags",
      "+faststart",
      opts.outPath,
    ]);
  }
  if (!fs.existsSync(opts.outPath) || fs.statSync(opts.outPath).size < 1024) {
    throw new Error("conform_delivery produced empty output");
  }
}

export function fileToDataUrl(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
