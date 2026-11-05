/**
 * Plate-assembly podcast cooks: edit supplied stems per producer EDL — no TTS / Lyria / new VO.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { AUDIO_EXTRACT_MODEL } from "./constants";
import { parseRunInputs, type RunInputAsset } from "./inputs";
import { runDir } from "./paths";
import { probeFile } from "./stitch";
import type { RunRow } from "../db";

const execFileAsync = promisify(execFile);

export type AssemblyEdl = {
  media_desc: string;
  /** Source-timeline removals on the mixed interview (seconds). */
  cuts: Array<{ start: number; end: number }>;
  /** Replace a mixed range with an isolated mic range (same source TC when aligned). */
  patches: Array<{
    mixedStart: number;
    mixedEnd: number;
    iso: "richard" | "pete";
    isoStart: number;
    isoEnd: number;
    gainDb?: number;
  }>;
  /** Source TC on mixed where sponsor ad inserts (after parent/child beat). */
  adInsertSourceSec: number;
  /** Source TC range to drop (producer wrap / time warning) near the end. */
  closingCut: { start: number; end: number } | null;
  /** Seconds of intro music to keep under the top of the interview before fade. */
  introUnderSec: number;
  /**
   * Cold-open: keep this many seconds of the uncut monologue BEFORE the official intro bumper.
   * 0 = classic intro-first layout (Prove It).
   */
  hookEndSec?: number;
  headSilenceSec?: number;
  tailSilenceSec?: number;
  loudnormI?: number;
  loudnormTp?: number;
  pcmBitDepth?: 16 | 24;
  /** Soft program budget before silence pads (seconds). */
  maxProgramSec?: number;
};

export function isAssemblyBrief(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const podcasty = /\bpodcast\b/.test(p) || /\bepisode\b/.test(p) || /\bstudy spark\b/.test(p);
  const plateEdit =
    /\bsupplied (recordings|materials|audio|intro|outro)\b/.test(p) ||
    /\bno (outside music|synthetic|new dialogue)\b/.test(p) ||
    /\bonly the supplied\b/.test(p) ||
    /\bedit(ing)? (client )?brief\b/.test(p) ||
    /\bproducer edit log\b/.test(p) ||
    /\bpublish-ready episode\b/.test(p) ||
    /\bhow to cut it\b/.test(p) ||
    /\buncut\b/.test(p) ||
    /\bpre-produced\b/.test(p) ||
    /\btalksy\b/.test(p);
  return podcasty && plateEdit;
}

type Roles = {
  mixed?: RunInputAsset;
  richard?: RunInputAsset;
  pete?: RunInputAsset;
  intro?: RunInputAsset;
  outro?: RunInputAsset;
  ad?: RunInputAsset;
};

export function resolvePodcastRoles(run: RunRow): Roles {
  const audios = parseRunInputs(run.input_assets_json).filter((a) => a.kind === "audio");
  const discard = /not[\s_-]*used|in_?outtro|_raw\b|\braw\b|\berror\b/i;
  const usable = audios.filter((a) => !discard.test(a.filename));
  const pick = (re: RegExp, pool: RunInputAsset[] = usable) => pool.find((a) => re.test(a.filename));
  // Prefer shorter official bumpers over long raw beds when multiple match.
  const shortest = (re: RegExp) => {
    const hits = usable.filter((a) => re.test(a.filename));
    if (!hits.length) return undefined;
    return [...hits].sort((a, b) => {
      const sa = fs.existsSync(a.path) ? fs.statSync(a.path).size : 0;
      const sb = fs.existsSync(b.path) ? fs.statSync(b.path).size : 0;
      return sa - sb;
    })[0];
  };
  return {
    mixed:
      pick(/uncut/i) ??
      pick(/^podcast-uncut\.wav$/i) ??
      pick(/mixed|interview|monologue/i),
    richard: pick(/richard/i, audios),
    pete: pick(/pete/i, audios),
    intro: shortest(/intro/i) ?? pick(/jingle[_-]?in|opening/i),
    outro: shortest(/outtro/i) ?? shortest(/outro/i) ?? pick(/jingle[_-]?out|ending/i),
    ad: pick(/talksy/i) ?? pick(/\bad\b|sponsor|advert/i),
  };
}

export function defaultStudySparkEdl(): AssemblyEdl {
  return {
    media_desc: "STUDY SPARK — solo study tips episode (finished master)",
    cuts: [],
    patches: [],
    adInsertSourceSec: 420,
    closingCut: null,
    introUnderSec: 0,
    hookEndSec: 12,
    headSilenceSec: 5,
    tailSilenceSec: 5,
    loudnormI: -16,
    loudnormTp: -1.0,
    pcmBitDepth: 16,
    maxProgramSec: 850, // ~14:10 including silence pads
  };
}

/** Default EDL from KasLix Prove It producer edit log (source TC on mixed). */
export function defaultProveItEdl(): AssemblyEdl {
  return {
    media_desc: "Prove It — Could AI create a utopia? (finished episode master)",
    cuts: [
      { start: 5, end: 8 },
      { start: 17, end: 32 },
      { start: 150, end: 222 },
      { start: 599, end: 605 }, // duplicate Pete line (keep 592–599)
    ],
    patches: [
      { mixedStart: 225, mixedEnd: 227, iso: "richard", isoStart: 225, isoEnd: 227 },
      { mixedStart: 347, mixedEnd: 349, iso: "richard", isoStart: 347, isoEnd: 349 },
      { mixedStart: 404, mixedEnd: 406, iso: "pete", isoStart: 404, isoEnd: 406 },
      { mixedStart: 534, mixedEnd: 550, iso: "pete", isoStart: 534, isoEnd: 550, gainDb: 3 },
    ],
    adInsertSourceSec: 420, // refined by Gemini when possible
    // Producer wrap near end of mixed (retain Richard’s closing before outro).
    closingCut: { start: 668, end: 702 },
    introUnderSec: 12,
  };
}

function geminiKey(): string {
  const k = process.env.GEMINI_API_KEY?.trim();
  if (!k) throw new Error("GEMINI_API_KEY is missing for podcast assembly planning.");
  return k;
}

/** Ask Gemini to refine ad insert + closing cut from brief (+ optional attachment text). */
export async function refineAssemblyEdlWithGemini(opts: {
  operatorPrompt: string;
  briefText: string;
  mixedDurationSec: number;
  base: AssemblyEdl;
  onStatus?: (msg: string) => void;
}): Promise<AssemblyEdl> {
  opts.onStatus?.(`Gemini assembly EDL refine (${AUDIO_EXTRACT_MODEL})…`);
  const ai = new GoogleGenAI({ apiKey: geminiKey() });
  const solo = /study spark|solo episode|monologue/i.test(opts.operatorPrompt);
  const targetHint = solo
    ? "Target finished PROGRAM (before/after digital silence pads) about 810–840s (~13:30–14:00). Trim filler/reiteration and clap redo flags; keep study throughline + health/gastritis beats."
    : "Target finished show under 660s (~10 min preferred).";
  const prompt = [
    "You are finishing a podcast EDL. Return ONE JSON object only.",
    "Use the producer edit log / editing brief when present. Do not invent new dialogue or music. Edit supplied plates only.",
    "Fields:",
    "media_desc: short episode description",
    "cuts: array of {start,end} source-seconds to REMOVE from the uncut/mixed take (filler, restatements, clap redo flags, fashion/hobby tangents).",
    solo
      ? "patches: [] (solo monologue — no iso mic repairs)."
      : "patches: array of {mixedStart,mixedEnd,iso:'richard'|'pete',isoStart,isoEnd,gainDb?} for dropout repairs.",
    "ad_insert_source_sec: source TC on the uncut/mixed take where the sponsor mid-roll should INSERT (listen for the host mentioning the sponsor / natural pause).",
    "closing_cut: {start,end} source TC of producer wrap/time-warning to remove near the end, or null.",
    "intro_under_sec: seconds of intro music bed under the top of dialogue after the bumper (0–4 for cold-open shows; 8–16 for intro-first).",
    "hook_end_sec: for cold-open shows, seconds of monologue BEFORE the official intro bumper (typically 8–20). Use 0 for intro-first.",
    `Mixed/uncut duration is about ${opts.mixedDurationSec.toFixed(1)}s. ${targetHint}`,
    "",
    "OPERATOR BRIEF:",
    opts.operatorPrompt.trim(),
    "",
    "CLIENT BRIEF / EDIT LOG:",
    opts.briefText.slice(0, 24000),
    "",
    "BASE_EDL_JSON:",
    JSON.stringify(opts.base),
  ].join("\n");

  const result = await ai.models.generateContent({
    model: AUDIO_EXTRACT_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });
  const raw = (result.text ?? "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) return opts.base;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const cuts = Array.isArray(parsed.cuts)
      ? (parsed.cuts as Array<{ start?: number; end?: number }>)
          .map((c) => ({ start: Number(c.start), end: Number(c.end) }))
          .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      : opts.base.cuts;
    const patches = Array.isArray(parsed.patches)
      ? (parsed.patches as Array<Record<string, unknown>>)
          .map((p) => ({
            mixedStart: Number(p.mixedStart ?? p.mixed_start),
            mixedEnd: Number(p.mixedEnd ?? p.mixed_end),
            iso: String(p.iso ?? "richard").toLowerCase() === "pete" ? ("pete" as const) : ("richard" as const),
            isoStart: Number(p.isoStart ?? p.iso_start ?? p.mixedStart ?? p.mixed_start),
            isoEnd: Number(p.isoEnd ?? p.iso_end ?? p.mixedEnd ?? p.mixed_end),
            gainDb: p.gainDb != null || p.gain_db != null ? Number(p.gainDb ?? p.gain_db) : undefined,
          }))
          .filter((p) => p.mixedEnd > p.mixedStart)
      : opts.base.patches;
    const ad = Number(parsed.ad_insert_source_sec ?? parsed.adInsertSourceSec);
    const closing = parsed.closing_cut ?? parsed.closingCut;
    let closingCut: AssemblyEdl["closingCut"] = opts.base.closingCut;
    if (closing && typeof closing === "object") {
      const c = closing as { start?: number; end?: number };
      const s = Number(c.start);
      const e = Number(c.end);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) closingCut = { start: s, end: e };
    } else if (closing === null) {
      closingCut = null;
    }
    const hookRaw = Number(parsed.hook_end_sec ?? parsed.hookEndSec ?? opts.base.hookEndSec ?? 0);
    const introUnderRaw = Number(
      parsed.intro_under_sec ?? parsed.introUnderSec ?? opts.base.introUnderSec ?? 0,
    );
    return {
      media_desc: String(parsed.media_desc ?? parsed.mediaDesc ?? opts.base.media_desc),
      cuts: cuts.length ? cuts : opts.base.cuts,
      patches: solo ? [] : patches.length ? patches : opts.base.patches,
      adInsertSourceSec: Number.isFinite(ad) && ad > 0 ? ad : opts.base.adInsertSourceSec,
      closingCut,
      introUnderSec: Math.max(0, Math.min(24, Number.isFinite(introUnderRaw) ? introUnderRaw : 0)),
      hookEndSec: Math.max(0, Math.min(45, Number.isFinite(hookRaw) ? hookRaw : 0)),
      headSilenceSec: opts.base.headSilenceSec ?? 0,
      tailSilenceSec: opts.base.tailSilenceSec ?? 0,
      loudnormI: opts.base.loudnormI ?? -18,
      loudnormTp: opts.base.loudnormTp ?? -3,
      pcmBitDepth: opts.base.pcmBitDepth ?? 24,
      maxProgramSec: opts.base.maxProgramSec,
    };
  } catch {
    return opts.base;
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Map a source timeline TC through removals → edited timeline position. */
function sourceToEdited(sourceSec: number, cuts: AssemblyEdl["cuts"]): number {
  let out = sourceSec;
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    if (sourceSec <= c.start) break;
    const rem = Math.min(sourceSec, c.end) - c.start;
    if (rem > 0) out -= rem;
  }
  return Math.max(0, out);
}

/**
 * Build dialogue WAV from mixed + patches, applying editorial cuts.
 * Returns path + duration.
 */
async function buildDialogue(opts: {
  mixed: string;
  richard?: string;
  pete?: string;
  edl: AssemblyEdl;
  outDir: string;
}): Promise<{ path: string; duration: number }> {
  const work = path.join(opts.outDir, "dialogue_work");
  fs.mkdirSync(work, { recursive: true });

  // 1) Start from mixed, apply local patches as overlay slices into a patched mix.
  let current = opts.mixed;
  let idx = 0;
  for (const p of opts.edl.patches) {
    const isoPath = p.iso === "richard" ? opts.richard : opts.pete;
    if (!isoPath || !fs.existsSync(isoPath)) continue;
    const out = path.join(work, `patched_${idx++}.wav`);
    const dur = p.mixedEnd - p.mixedStart;
    const gain = p.gainDb != null ? `,volume=${p.gainDb}dB` : "";
    // Extract iso slice, then overlay onto mixed at mixedStart.
    await ffmpeg([
      "-i",
      current,
      "-ss",
      p.isoStart.toFixed(3),
      "-t",
      dur.toFixed(3),
      "-i",
      isoPath,
      "-filter_complex",
      `[1:a]aformat=sample_rates=44100:channel_layouts=stereo${gain},adelay=${Math.round(p.mixedStart * 1000)}|${Math.round(p.mixedStart * 1000)}[fix];` +
        `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[base];` +
        // Duck/replace: volume 0 on base in the window, then amix
        `[base]volume=enable='between(t,${p.mixedStart.toFixed(3)},${p.mixedEnd.toFixed(3)})':volume=0[b0];` +
        `[b0][fix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
      "-map",
      "[a]",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s24le",
      out,
    ]);
    current = out;
  }

  // 2) Keep ranges between cuts (+ optional closing cut).
  const cuts = [...opts.edl.cuts];
  if (opts.edl.closingCut) cuts.push(opts.edl.closingCut);
  cuts.sort((a, b) => a.start - b.start);
  const mixedDur = (await probeFile(current)).duration ?? 0;
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor) keep.push({ start: cursor, end: Math.min(c.start, mixedDur) });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < mixedDur) keep.push({ start: cursor, end: mixedDur });

  const parts: string[] = [];
  for (let i = 0; i < keep.length; i++) {
    const seg = keep[i]!;
    const part = path.join(work, `keep_${i}.wav`);
    const len = seg.end - seg.start;
    if (len < 0.05) continue;
    await ffmpeg([
      "-ss",
      seg.start.toFixed(3),
      "-t",
      len.toFixed(3),
      "-i",
      current,
      "-af",
      "afade=t=in:st=0:d=0.02,afade=t=out:st=" + Math.max(0, len - 0.04).toFixed(3) + ":d=0.04",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s24le",
      part,
    ]);
    parts.push(part);
  }
  if (!parts.length) throw new Error("Dialogue assembly produced no keep segments");

  const listFile = path.join(work, "concat.txt");
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");
  const dialogue = path.join(opts.outDir, "dialogue_edited.wav");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", dialogue]);
  const dur = (await probeFile(dialogue)).duration ?? 0;
  return { path: dialogue, duration: dur };
}

async function pcmCodec(bits: 16 | 24): Promise<"pcm_s16le" | "pcm_s24le"> {
  return bits === 16 ? "pcm_s16le" : "pcm_s24le";
}

async function writeSilenceWav(dest: string, sec: number, bits: 16 | 24): Promise<void> {
  const codec = await pcmCodec(bits);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=44100:cl=stereo`,
    "-t",
    Math.max(0.1, sec).toFixed(3),
    "-c:a",
    codec,
    dest,
  ]);
}

async function acrossfadeChain(inputs: string[], dest: string, bits: 16 | 24, fade = 0.3): Promise<void> {
  if (inputs.length === 0) throw new Error("acrossfadeChain: no inputs");
  if (inputs.length === 1) {
    await ffmpeg(["-i", inputs[0]!, "-ar", "44100", "-ac", "2", "-c:a", await pcmCodec(bits), dest]);
    return;
  }
  const args: string[] = [];
  for (const p of inputs) args.push("-i", p);
  const parts: string[] = [];
  let prev = "[0:a]";
  for (let i = 1; i < inputs.length; i++) {
    const out = i === inputs.length - 1 ? "[a]" : `[a${i}]`;
    parts.push(`${prev}[${i}:a]acrossfade=d=${fade}:c1=tri:c2=tri${out}`);
    prev = out;
  }
  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[a]",
    "-ar",
    "44100",
    "-c:a",
    await pcmCodec(bits),
    dest,
  );
  await ffmpeg(args);
}

/** Full episode from supplied plates → 44.1 kHz WAV master (loudness/bit depth from EDL). */
export async function assemblePodcastEpisode(opts: {
  run: RunRow;
  edl: AssemblyEdl;
  onStatus?: (msg: string) => void;
}): Promise<{ masterWav: string; duration: number }> {
  const roles = resolvePodcastRoles(opts.run);
  if (!roles.mixed?.path) throw new Error("Podcast assembly needs the mixed/uncut interview WAV.");
  if (!roles.intro?.path || !roles.outro?.path || !roles.ad?.path) {
    throw new Error("Podcast assembly needs official intro, outro, and sponsor ad assets.");
  }

  const bits: 16 | 24 = opts.edl.pcmBitDepth === 16 ? 16 : 24;
  const codec = await pcmCodec(bits);
  const lufs = opts.edl.loudnormI ?? -18;
  const tp = opts.edl.loudnormTp ?? -3;
  const headSil = Math.max(0, opts.edl.headSilenceSec ?? 0);
  const tailSil = Math.max(0, opts.edl.tailSilenceSec ?? 0);
  const hookEnd = Math.max(0, opts.edl.hookEndSec ?? 0);
  const maxProgram = opts.edl.maxProgramSec ?? 655;

  const outDir = path.join(runDir(opts.run.id), "audio", "assemble");
  fs.mkdirSync(outDir, { recursive: true });

  opts.onStatus?.("Editing dialogue (cuts + mic repairs)…");
  const dialogue = await buildDialogue({
    mixed: roles.mixed.path,
    richard: roles.richard?.path,
    pete: roles.pete?.path,
    edl: opts.edl,
    outDir,
  });

  const adAtEdited = sourceToEdited(opts.edl.adInsertSourceSec, [
    ...opts.edl.cuts,
    ...(opts.edl.closingCut ? [opts.edl.closingCut] : []),
  ]);
  // Keep ad away from hook/intro zone and the very end.
  const minAd = Math.max(hookEnd + 20, 25);
  const clampAd = Math.min(Math.max(minAd, adAtEdited), Math.max(minAd + 1, dialogue.duration - 20));

  opts.onStatus?.(`Building program timeline (ad @ ${clampAd.toFixed(1)}s edited, hook=${hookEnd.toFixed(1)}s)…`);

  const intro = roles.intro.path;
  const outro = roles.outro.path;
  const ad = roles.ad.path;
  const introProbe = await probeFile(intro);
  const introDur = introProbe.duration ?? 40;
  const under = Math.min(opts.edl.introUnderSec || 0, Math.max(0, introDur * 0.35));

  const dialA = path.join(outDir, "dial_a.wav");
  const dialB = path.join(outDir, "dial_b.wav");
  await ffmpeg(["-i", dialogue.path, "-t", clampAd.toFixed(3), "-c", "copy", dialA]);
  await ffmpeg(["-ss", clampAd.toFixed(3), "-i", dialogue.path, "-c", "copy", dialB]);

  const introFull = path.join(outDir, "intro_full.wav");
  await ffmpeg(["-i", intro, "-ar", "44100", "-ac", "2", "-c:a", codec, introFull]);

  const outroFull = path.join(outDir, "outro.wav");
  await ffmpeg(["-i", outro, "-ar", "44100", "-ac", "2", "-c:a", codec, outroFull]);

  const adNorm = path.join(outDir, "ad.wav");
  await ffmpeg([
    "-i",
    ad,
    "-af",
    `loudnorm=I=${lufs}:TP=${tp}:LRA=11`,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    codec,
    adNorm,
  ]);

  // Optional ducked intro bed under the first slice of post-intro dialogue.
  let dialBody = dialA;
  if (under >= 1) {
    const bed = path.join(outDir, "intro_bed.wav");
    const bedStart = Math.max(0, introDur - under);
    await ffmpeg([
      "-ss",
      bedStart.toFixed(3),
      "-t",
      under.toFixed(3),
      "-i",
      intro,
      "-af",
      "volume=-21dB,afade=t=out:st=" + Math.max(0, under - 2).toFixed(3) + ":d=2",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      codec,
      bed,
    ]);
    const dialAUnder = path.join(outDir, "dial_a_under.wav");
    await ffmpeg([
      "-i",
      dialA,
      "-i",
      bed,
      "-filter_complex",
      "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[v];" +
        "[1:a]aformat=sample_rates=44100:channel_layouts=stereo,apad[b];" +
        "[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
      "-map",
      "[a]",
      "-ar",
      "44100",
      "-c:a",
      codec,
      dialAUnder,
    ]);
    dialBody = dialAUnder;
  }

  const chain: string[] = [];
  if (hookEnd > 0.5) {
    // Cold open: hook slice from dialA, then official intro, then remainder of dialA, ad, dialB, outro.
    const hook = path.join(outDir, "hook.wav");
    const afterHook = path.join(outDir, "after_hook.wav");
    const hookLen = Math.min(hookEnd, (await probeFile(dialBody)).duration ?? hookEnd);
    await ffmpeg(["-i", dialBody, "-t", hookLen.toFixed(3), "-c", "copy", hook]);
    await ffmpeg(["-ss", hookLen.toFixed(3), "-i", dialBody, "-c", "copy", afterHook]);
    chain.push(hook, introFull, afterHook, adNorm, dialB, outroFull);
  } else {
    chain.push(introFull, dialBody, adNorm, dialB, outroFull);
  }

  const programRaw = path.join(outDir, "program_raw.wav");
  await acrossfadeChain(chain, programRaw, bits, 0.28);

  let programForMaster = programRaw;
  let programDur = (await probeFile(programRaw)).duration ?? 0;
  const maxContent = Math.max(120, maxProgram - headSil - tailSil);
  if (programDur > maxContent + 5) {
    opts.onStatus?.(`Program ${programDur.toFixed(0)}s over budget — tightening mid dialogue…`);
    // Soft mid-body trim on dialB only (preserve hook/intro/ad/outro).
    const dialBDur = (await probeFile(dialB)).duration ?? 0;
    const overflow = programDur - maxContent;
    if (dialBDur > overflow + 40) {
      const keepHead = Math.max(20, dialBDur - overflow - 25);
      const keepTail = 25;
      const midCutEnd = keepHead + (dialBDur - keepHead - keepTail);
      const head = path.join(outDir, "dial_b_head.wav");
      const tail = path.join(outDir, "dial_b_tail.wav");
      const fittedB = path.join(outDir, "dial_b_fit.wav");
      await ffmpeg(["-i", dialB, "-t", keepHead.toFixed(3), "-c", "copy", head]);
      await ffmpeg(["-ss", midCutEnd.toFixed(3), "-i", dialB, "-c", "copy", tail]);
      const fitList = path.join(outDir, "fit_b_concat.txt");
      fs.writeFileSync(
        fitList,
        [`file '${head.replace(/\\/g, "/")}'`, `file '${tail.replace(/\\/g, "/")}'`].join("\n"),
        "utf8",
      );
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", fitList, "-c", "copy", fittedB]);
      const rebuilt = path.join(outDir, "program_fit.wav");
      const chain2 = hookEnd > 0.5
        ? [chain[0]!, chain[1]!, chain[2]!, chain[3]!, fittedB, chain[5]!]
        : [chain[0]!, chain[1]!, chain[2]!, fittedB, chain[4]!];
      await acrossfadeChain(chain2, rebuilt, bits, 0.28);
      programForMaster = rebuilt;
      programDur = (await probeFile(rebuilt)).duration ?? programDur;
    }
  }

  // Digital silence bookends (complete silence — no beds).
  if (headSil > 0 || tailSil > 0) {
    opts.onStatus?.(`Padding ${headSil}s head / ${tailSil}s tail silence…`);
    const parts: string[] = [];
    if (headSil > 0) {
      const hs = path.join(outDir, "silence_head.wav");
      await writeSilenceWav(hs, headSil, bits);
      parts.push(hs);
    }
    parts.push(programForMaster);
    if (tailSil > 0) {
      const ts = path.join(outDir, "silence_tail.wav");
      await writeSilenceWav(ts, tailSil, bits);
      parts.push(ts);
    }
    const listFile = path.join(outDir, "silence_concat.txt");
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");
    const padded = path.join(outDir, "program_padded.wav");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", padded]);
    programForMaster = padded;
  }

  opts.onStatus?.(
    `Mastering (${lufs} LUFS, ${tp} dBTP, 44.1 kHz / ${bits}-bit)…`,
  );
  const master = path.join(runDir(opts.run.id), "final.wav");
  await ffmpeg([
    "-i",
    programForMaster,
    "-af",
    `loudnorm=I=${lufs}:TP=${tp}:LRA=11`,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-c:a",
    codec,
    master,
  ]);

  const dur = (await probeFile(master)).duration ?? 0;
  if (dur < 30) throw new Error("Assembled podcast master too short");
  fs.copyFileSync(master, path.join(runDir(opts.run.id), "final_synced.wav"));
  return { masterWav: master, duration: dur };
}
