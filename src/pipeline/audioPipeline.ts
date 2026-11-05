/**
 * Gemini-native audio cooks:
 *   Google extract → speech (TTS, or provided guide when the brief forbids synth VO) → Lyria bed → light overlay.
 * Multi-master briefs export full mix + instrumental (+ optional preview cut), 44.1 kHz.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AUDIO_EXTRACT_MODEL,
  AUDIO_MUSIC_MODEL,
  AUDIO_TTS_MODEL,
} from "./constants";
import {
  extractAudioBriefWithGemini,
  generateLyriaMusic,
  generateSpeechTts,
  resolveTtsVoice,
} from "./geminiAudio";
import { runDir } from "./paths";
import { ensureAbsRunFile } from "./storage";
import { audioPlanSchema, type AudioPlan, type MetaRecord } from "./schema";
import { prepareRunInputs } from "./inputPrep";
import { formatInputsForScript, parseRunInputs, type RunInputAsset } from "./inputs";
import { mixAudioMaster, probeFile } from "./stitch";
import {
  appendMetaJsonl,
  copyIntoDataset,
  ensureDatasetLayout,
  withCatalogLock,
  writeDatasetInfo,
  writeSessionDeliveryJson,
} from "./export";
import { enqueueJob, getRun, updateRun, upsertAsset, type RunRow } from "../db";
import { exportUniqId } from "./session";
import {
  assemblePodcastEpisode,
  defaultProveItEdl,
  defaultStudySparkEdl,
  isAssemblyBrief,
  refineAssemblyEdlWithGemini,
  resolvePodcastRoles,
  type AssemblyEdl,
} from "./podcastAssemble";
import { assembleTourEpisode, isTourAssemblyBrief, resolveTourRoles } from "./tourAssemble";

const execFileAsync = promisify(execFile);

export function parseAudioPlan(run: RunRow): AudioPlan {
  if (!run.script_json) throw new Error("Audio plan missing");
  return audioPlanSchema.parse(JSON.parse(run.script_json));
}

export function isAudioRun(run: RunRow): boolean {
  return run.pipeline_mode === "audio";
}

/** Prefer attached Script*.pdf/docx text when present. */
function attachedScriptHint(run: RunRow): string {
  const assets = parseRunInputs(run.input_assets_json);
  const scriptish = assets
    .filter((a) => a.textContent && /script|monologue|email|correspondence|marsha|brief|engineer|podcast|lyric|take.?sheet/i.test(a.filename))
    .map((a) => `--- ${a.filename} ---\n${a.textContent}`)
    .join("\n\n");
  return scriptish;
}

/** Briefs that forbid synth VO and require the attached guide/a cappella as-is. */
function wantsProvidedGuideVocal(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    /\bguide (a\s*cappella|vocal|track)\b/.test(p) ||
    /\buse the guide\b/.test(p) ||
    /\bdo not generate or add any other vocals\b/.test(p) ||
    /\bno eq,? fx,? pitch\b/.test(p) ||
    /\blevel and panning only\b/.test(p)
  );
}

function wantsMultiMasterWavs(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    /\binstrumental singalong\b/.test(p) ||
    /\b15[- ]?second (cut|preview)\b/.test(p) ||
    /\b3\s*(stereo\s*)?\.?wav\b/.test(p) ||
    /\bfull demo mix\b/.test(p)
  );
}

function wantsPreviewCutSec(prompt: string): number | undefined {
  const m = prompt.match(/\b(15)\s*-?\s*second\s+(cut|preview)\b/i);
  return m ? Number(m[1]) : undefined;
}

/** Prefer staged guide_vocal / highest take that fits ~65–70s. */
function findProvidedSpeechAsset(run: RunRow): RunInputAsset | null {
  const audios = parseRunInputs(run.input_assets_json).filter((a) => a.kind === "audio");
  const candidates = audios.filter(
    (a) => !/style|reference|music.?bed|^bed\b|ambience|sfx|effect/i.test(a.filename),
  );
  const scored = candidates
    .map((a) => {
      let score = 0;
      if (/guide.?vocal|guide.?a.?cappella|a.?cappella/i.test(a.filename)) score += 20;
      if (/monologue/i.test(a.filename)) score += 10;
      const take = a.filename.match(/take[_\s-]?(\d+)/i);
      if (take) score += Number(take[1]) * 2;
      if (/\.wav$/i.test(a.filename)) score += 1;
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  if (scored[0]) return scored[0].a;
  return candidates.length === 1 ? candidates[0]! : null;
}

async function ffmpegWavMaster(
  input: string,
  output: string,
  opts?: { duration?: number; fadeOutSec?: number; bitDepth?: 16 | 24 },
) {
  const af: string[] = [];
  if (opts?.fadeOutSec && opts.duration && opts.duration > opts.fadeOutSec) {
    const st = Math.max(0, opts.duration - opts.fadeOutSec);
    af.push(`afade=t=out:st=${st.toFixed(3)}:d=${opts.fadeOutSec.toFixed(3)}`);
  }
  const codec = (opts?.bitDepth ?? 16) === 24 ? "pcm_s24le" : "pcm_s16le";
  const args = ["-hide_banner", "-nostdin", "-y", "-i", input];
  if (opts?.duration && opts.duration > 0) args.push("-t", opts.duration.toFixed(3));
  if (af.length) args.push("-af", af.join(","));
  args.push("-ar", "44100", "-ac", "2", "-c:a", codec, output);
  await execFileAsync("ffmpeg", args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (!fs.existsSync(output) || fs.statSync(output).size < 256) {
    throw new Error(`ffmpegWavMaster failed: ${output}`);
  }
}

/** @deprecated alias */
async function ffmpegWav4416(input: string, output: string, opts?: { duration?: number; fadeOutSec?: number }) {
  await ffmpegWavMaster(input, output, { ...opts, bitDepth: 16 });
}

export async function jobAudioPlan(run: RunRow): Promise<void> {
  await updateRun(run.id, { status: "generating", gate: null, error: "Gemini extract (script/style/music)…" });
  run = await prepareRunInputs(run, async (msg) => {
    await updateRun(run.id, { error: msg });
  });

  const attachments = [attachedScriptHint(run), formatInputsForScript(run.input_assets_json)]
    .filter(Boolean)
    .join("\n\n");

  // Guided audio tour from supplied stems — never TTS / Lyria.
  if (isTourAssemblyBrief(run.initial_prompt) && resolveTourRoles(run).narration) {
    const roles = resolveTourRoles(run);
    const plan: AudioPlan = {
      media_desc: "Guided audio tour assembled from supplied stems",
      target_duration: run.target_duration,
      music: { prompt: "supplied historical bed", instrumental: true },
      cues: [
        {
          index: 0,
          kind: "speech",
          start: 0,
          end: run.target_duration,
          text: "[tour] Preserve supplied narration; insert walking transitions; place SFX per brief.",
        },
      ],
      use_provided_speech: true,
      dual_masters: false,
      wav_bit_depth: 16,
      music_only: false,
      tour_assembly: true,
      assembly: false,
    };
    await updateRun(run.id, {
      script_json: JSON.stringify(plan),
      error: `Tour EDL ready (narration=${roles.narration?.filename}) — assembling…`,
    });
    await enqueueJob(run.id, "audio_assemble");
    return;
  }

  // Plate-assembly podcast: edit supplied stems only — never TTS / Lyria.
  if (isAssemblyBrief(run.initial_prompt) && resolvePodcastRoles(run).mixed) {
    await updateRun(run.id, { error: "Podcast assembly EDL (brief edit log)…" });
    const roles = resolvePodcastRoles(run);
    const mixedDur = (await probeFile(roles.mixed!.path)).duration ?? run.target_duration;
    const briefText =
      parseRunInputs(run.input_assets_json)
        .filter((a) => a.textContent && /brief|edit|engineer|podcast|spark/i.test(a.filename))
        .map((a) => a.textContent)
        .join("\n\n") || attachments;
    const base = /study spark/i.test(run.initial_prompt) ? defaultStudySparkEdl() : defaultProveItEdl();
    const edl = await refineAssemblyEdlWithGemini({
      operatorPrompt: run.initial_prompt,
      briefText,
      mixedDurationSec: mixedDur,
      base,
      onStatus: async (msg) => await updateRun(run.id, { error: msg }),
    });
    const plan: AudioPlan = {
      media_desc: edl.media_desc,
      target_duration: run.target_duration,
      music: { prompt: "supplied branding only", instrumental: true },
      cues: [
        {
          index: 0,
          kind: "speech",
          start: 0,
          end: run.target_duration,
          text: "[assembly] Use only supplied podcast plates per producer edit log — no synthetic speech.",
          style: undefined,
          voice: "Sulafat",
        },
      ],
      use_provided_speech: true,
      dual_masters: false,
      wav_bit_depth: edl.pcmBitDepth === 16 ? 16 : 24,
      music_only: false,
      tour_assembly: false,
      assembly: true,
      assembly_edl_json: JSON.stringify(edl),
    };
    await updateRun(run.id, {
      script_json: JSON.stringify(plan),
      error: "EDL ready — assembling episode from plates…",
    });
    await enqueueJob(run.id, "audio_assemble");
    return;
  }

  // Generative core: Gemini extract (+ hear attached audio) → TTS / Lyria.
  const audioPayload = parseRunInputs(run.input_assets_json)
    .filter((a) => a.kind === "audio" && a.path && fs.existsSync(a.path))
    // Prefer speech/mic sources over huge music beds for extract context.
    .filter((a) => !/music.?bed|style_reference/i.test(a.filename))
    .sort((a, b) => {
      const score = (f: string) =>
        (/main|primary|guide|microphone|auditorium|mix/i.test(f) ? 0 : 1) + (/\.wav$/i.test(f) ? 0 : 1);
      return score(a.filename) - score(b.filename);
    })
    .slice(0, 3)
    .map((a) => a.path);

  const extracted = await extractAudioBriefWithGemini({
    operatorPrompt: run.initial_prompt,
    attachmentText: attachments,
    targetDurationSec: run.target_duration,
    audioPaths: audioPayload,
    onStatus: async (msg) => await updateRun(run.id, { error: msg }),
  });

  const musicOnly = extracted.musicOnly;
  const provided = findProvidedSpeechAsset(run);
  const useProvided = !musicOnly && wantsProvidedGuideVocal(run.initial_prompt) && Boolean(provided);
  const multi = wantsMultiMasterWavs(run.initial_prompt);
  const previewCut = wantsPreviewCutSec(run.initial_prompt);
  const bitDepth: 16 | 24 = /\b24-?bit\b/i.test(run.initial_prompt) ? 24 : 16;

  // Keep music length on the guide when using provided vocal.
  let targetDur = run.target_duration;
  if (useProvided && provided?.path) {
    const vd = (await probeFile(provided.path)).duration ?? targetDur;
    targetDur = Math.min(Math.max(vd, 65), Math.min(70, Math.max(vd, 65)));
    if (vd >= 65 && vd <= 70) targetDur = vd;
    else if (vd > 70) targetDur = 70;
    else targetDur = Math.max(65, Math.min(70, vd));
  }

  const speechStart = useProvided
    ? Math.min(1.5, Math.max(0, extracted.speechStartSec))
    : extracted.speechStartSec;

  const plan: AudioPlan = {
    media_desc: extracted.mediaDesc,
    target_duration: targetDur,
    music: {
      prompt: extracted.musicPrompt,
      instrumental: extracted.instrumental || musicOnly,
    },
    cues: [
      {
        index: 0,
        kind: "speech",
        start: speechStart,
        end: targetDur,
        text: musicOnly
          ? "MUSIC ONLY — no voiceover in master."
          : useProvided
            ? "[provided guide vocal — preserve as recorded]"
            : extracted.script,
        style: musicOnly || useProvided ? undefined : extracted.style || undefined,
        voice: resolveTtsVoice(undefined, "Sulafat"),
      },
    ],
    use_provided_speech: useProvided,
    dual_masters: multi || useProvided,
    preview_cut_sec: previewCut,
    wav_bit_depth: bitDepth,
    music_only: musicOnly,
    tour_assembly: false,
    assembly: false,
  };

  await updateRun(run.id, {
    script_json: JSON.stringify(plan),
    error: musicOnly
      ? `Extracted — music-only Lyria…`
      : useProvided
        ? `Extracted — guide vocal + Lyria${multi ? " (full/instrumental/preview)" : ""}…`
        : `Extracted via ${AUDIO_EXTRACT_MODEL} — Gemini TTS + Lyria…`,
  });
  await enqueueJob(run.id, musicOnly ? "audio_music" : "audio_speech");
}

export async function jobAudioAssemble(run: RunRow): Promise<void> {
  const plan = parseAudioPlan(run);
  if (!plan.assembly && !plan.tour_assembly) {
    throw new Error("audio_assemble job on non-assembly plan");
  }

  let masterWav: string;
  let duration: number;
  let mediaDesc: string;
  let mode: string;
  let tags: string[];

  if (plan.tour_assembly) {
    await updateRun(run.id, { status: "stitching", error: "Assembling guided audio tour from stems…" });
    const tour = await assembleTourEpisode({
      run,
      onStatus: async (msg) => await updateRun(run.id, { error: msg }),
    });
    masterWav = tour.masterWav;
    duration = tour.duration;
    mediaDesc = tour.mediaDesc;
    mode = "tour-assembly";
    tags = ["audio", "tour", "assembly", "supplied-stems"];
  } else {
    let edl: AssemblyEdl = defaultProveItEdl();
    if (plan.assembly_edl_json) {
      try {
        const parsed = JSON.parse(plan.assembly_edl_json) as Partial<AssemblyEdl>;
        edl = {
          ...edl,
          ...parsed,
          closingCut: parsed.closingCut ?? edl.closingCut,
          cuts: parsed.cuts?.length ? parsed.cuts : edl.cuts,
          patches: parsed.patches?.length ? parsed.patches : edl.patches,
        };
      } catch {
        /* keep default */
      }
    }
    await updateRun(run.id, { status: "stitching", error: "Assembling podcast master from plates…" });
    const pod = await assemblePodcastEpisode({
      run,
      edl,
      onStatus: async (msg) => await updateRun(run.id, { error: msg }),
    });
    masterWav = pod.masterWav;
    duration = pod.duration;
    mediaDesc = edl.media_desc;
    mode = "podcast-assembly";
    tags = ["audio", "podcast", "assembly", "gemini-edl"];
  }

  // Single 44.1 / 24-bit WAV delivery (no stems / dual masters).
  const outM4a = path.join(runDir(run.id), "final.m4a");
  await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-y", "-i", masterWav, "-c:a", "aac", "-b:a", "256k", outM4a],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );

  const exportPlan: AudioPlan = {
    ...plan,
    media_desc: mediaDesc,
    target_duration: duration,
    dual_masters: false,
    cues: [
      {
        index: 0,
        kind: "speech",
        start: 0,
        end: duration,
        text: plan.cues[0]?.text ?? "[assembly]",
      },
    ],
  };
  await updateRun(run.id, { script_json: JSON.stringify(exportPlan) });

  fs.writeFileSync(
    path.join(runDir(run.id), "audio_mix_report.json"),
    JSON.stringify({ mode, masterWav, duration }, null, 2),
  );

  ensureDatasetLayout();
  const fresh = (await getRun(run.id))!;
  const wavRel = copyIntoDataset(masterWav, `audio/agent_generated/${fresh.session_id}_final.wav`);
  copyIntoDataset(outM4a, `audio/agent_generated/${fresh.session_id}_final.m4a`);
  const uniq = exportUniqId(fresh.session_id, "audio_final");
  const meta: MetaRecord = {
    uniq_id: uniq,
    modality: "audio",
    generation_type: "agent_audio",
    media_id: path.basename(wavRel),
    media_desc: mediaDesc,
    media_path: wavRel,
    format: "wav",
    width: 1,
    height: 1,
    duration,
    fps: null,
    resolution: null,
    prompt: fresh.initial_prompt.slice(0, 2000),
    model_name: `${AUDIO_EXTRACT_MODEL}+ffmpeg-assembly`,
    category: fresh.category,
    tags,
    session_id: fresh.session_id,
    round_index: null,
    parent_uniq_id: null,
    audio_path: wavRel,
    origin_media_id: null,
    origin_media_path: null,
    mask_path: null,
    reference_images: [],
    ext_json: {
      source_platform: "Internal Pipeline",
      content_safety: "pass",
      visual_style: plan.tour_assembly ? "guided audio tour assembly" : "podcast plate assembly",
    },
  };
  const written = await withCatalogLock(() => {
    const result = appendMetaJsonl([meta]);
    if (!result.ok) return result;
    writeSessionDeliveryJson(fresh.session_id, [meta]);
    return result;
  });
  if (!written.ok) throw new Error(written.errors.join("; "));
  writeDatasetInfo();
  await upsertAsset({
    uniq_id: uniq,
    run_id: fresh.id,
    shot_index: null,
    role: "stitch",
    path: wavRel,
    parent_uniq_id: null,
    meta_json: JSON.stringify(meta),
  });
  await updateRun(fresh.id, { status: "exported", counted: 0, gate: null, error: null });
}

export async function jobAudioSpeech(run: RunRow): Promise<void> {
  const plan = parseAudioPlan(run);
  const speechDir = path.join(runDir(run.id), "audio", "speech");
  fs.mkdirSync(speechDir, { recursive: true });

  const fullText = plan.cues.map((c) => c.text.trim()).filter(Boolean).join("\n\n");
  const style = plan.cues.find((c) => c.style)?.style ?? undefined;
  const voice = resolveTtsVoice(plan.cues[0]?.voice, "Sulafat");
  const start = plan.cues[0]?.start ?? 0;
  const outPath = path.join(speechDir, "cue_0.wav");

  if (plan.use_provided_speech) {
    const asset = findProvidedSpeechAsset(run);
    if (!asset?.path || !fs.existsSync(asset.path)) {
      throw new Error("Brief requires provided guide vocal, but no guide/VO attachment was found.");
    }
    await updateRun(run.id, {
      status: "generating",
      error: `Using guide vocal (${asset.filename}) — level/pan only, no TTS…`,
      current_shot_index: 0,
    });
    if (!(fs.existsSync(outPath) && fs.statSync(outPath).size > 256)) {
      // Pass-through decode to stereo WAV — no EQ / pitch / time stretch.
      await ffmpegWavMaster(asset.path, outPath, { bitDepth: plan.wav_bit_depth ?? 16 });
    }
  } else {
    await updateRun(run.id, {
      status: "generating",
      error: `Gemini TTS single take (${AUDIO_TTS_MODEL}, voice=${voice})…`,
      current_shot_index: 0,
    });
    if (!(fs.existsSync(outPath) && fs.statSync(outPath).size > 256)) {
      await generateSpeechTts({
        text: fullText,
        style: style ?? undefined,
        voice,
        outPath,
        onStatus: async (msg) => await updateRun(run.id, { error: msg }),
      });
    }
  }

  const collapsed: AudioPlan = {
    ...plan,
    cues: [
      {
        index: 0,
        kind: "speech",
        start,
        end: plan.target_duration,
        text: fullText,
        style: style ?? undefined,
        voice,
      },
    ],
  };
  await updateRun(run.id, {
    script_json: JSON.stringify(collapsed),
    error: "Speech ready — Lyria bed…",
  });
  await enqueueJob(run.id, "audio_music");
}

export async function jobAudioMusic(run: RunRow): Promise<void> {
  const plan = parseAudioPlan(run);
  const musicDir = path.join(runDir(run.id), "audio", "music");
  fs.mkdirSync(musicDir, { recursive: true });
  const outPath = path.join(musicDir, "bed.wav");

  await updateRun(run.id, {
    status: "generating",
    error: `Lyria (${AUDIO_MUSIC_MODEL})…`,
  });

  if (!(fs.existsSync(outPath) && fs.statSync(outPath).size > 256)) {
    await generateLyriaMusic({
      prompt: plan.music.prompt,
      instrumental: plan.music.instrumental,
      durationSec: plan.target_duration,
      outPath,
      onStatus: async (msg) => await updateRun(run.id, { error: msg }),
    });
  }

  const mp3 = path.join(musicDir, "bed.mp3");
  const musicPath =
    fs.existsSync(outPath) && fs.statSync(outPath).size > 256
      ? outPath
      : fs.existsSync(mp3)
        ? mp3
        : outPath;

  fs.writeFileSync(path.join(musicDir, "bed_path.txt"), musicPath, "utf8");
  await updateRun(run.id, {
    error: plan.music_only
      ? "Remux Lyria → 48 kHz / 24-bit (no post)…"
      : plan.dual_masters
        ? "Building clean + synced masters…"
        : "Light overlay…",
  });
  await enqueueJob(run.id, "audio_mix");
}

/** Music-only masters: remux Lyria as-generated to exact duration — no duck/loudnorm/TTS. */
async function exportMusicOnlyMaster(run: RunRow, plan: AudioPlan, musicPath: string): Promise<void> {
  const dur = plan.target_duration;
  const outWav = path.join(runDir(run.id), "final.wav");
  await updateRun(run.id, { status: "stitching", error: "Packaging music-only WAV (48 kHz / 24-bit)…" });
  // Remux only: trim/pad to target length + sample format. No EQ, loudnorm, fades, or overlays.
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      musicPath,
      "-t",
      dur.toFixed(3),
      "-af",
      `apad=whole_dur=${dur.toFixed(3)}`,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s24le",
      outWav,
    ],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 256) {
    throw new Error("Music-only remux produced empty WAV");
  }

  const probe = await probeFile(outWav);
  fs.writeFileSync(
    path.join(runDir(run.id), "audio_mix_report.json"),
    JSON.stringify(
      {
        probe,
        musicPath,
        mode: "lyria-music-only",
        music: AUDIO_MUSIC_MODEL,
        extract: AUDIO_EXTRACT_MODEL,
        post: "none",
      },
      null,
      2,
    ),
  );

  ensureDatasetLayout();
  const fresh = (await getRun(run.id))!;
  const wavRel = copyIntoDataset(outWav, `audio/agent_generated/${fresh.session_id}_final.wav`);
  const uniq = exportUniqId(fresh.session_id, "audio_final");
  const meta: MetaRecord = {
    uniq_id: uniq,
    modality: "audio",
    generation_type: "agent_audio",
    media_id: path.basename(wavRel),
    media_desc: plan.media_desc,
    media_path: wavRel,
    format: "wav",
    width: 1,
    height: 1,
    duration: probe.duration ?? dur,
    fps: null,
    resolution: null,
    prompt: fresh.initial_prompt.slice(0, 2000),
    model_name: `${AUDIO_EXTRACT_MODEL}+${AUDIO_MUSIC_MODEL}`,
    category: fresh.category,
    tags: ["audio", "lyria", "music-only", "instrumental", "gemini-native"],
    session_id: fresh.session_id,
    round_index: null,
    parent_uniq_id: null,
    audio_path: wavRel,
    origin_media_id: null,
    origin_media_path: null,
    mask_path: null,
    reference_images: [],
    ext_json: {
      source_platform: "Internal Pipeline",
      content_safety: "pass",
      visual_style: plan.music.prompt.slice(0, 200),
    },
  };
  const written = await withCatalogLock(() => {
    const result = appendMetaJsonl([meta]);
    if (!result.ok) return result;
    writeSessionDeliveryJson(fresh.session_id, [meta]);
    return result;
  });
  if (!written.ok) throw new Error(written.errors.join("; "));
  writeDatasetInfo();
  await upsertAsset({
    uniq_id: uniq,
    run_id: fresh.id,
    shot_index: null,
    role: "stitch",
    path: wavRel,
    parent_uniq_id: null,
    meta_json: JSON.stringify(meta),
  });
  await updateRun(fresh.id, { status: "exported", counted: 0, gate: null, error: null });
}

export async function jobAudioMix(run: RunRow): Promise<void> {
  const plan = parseAudioPlan(run);
  const speechDir = path.join(runDir(run.id), "audio", "speech");
  const musicDir = path.join(runDir(run.id), "audio", "music");
  // Pull bed / speech from bucket when this container's scratch was cleared.
  for (const rel of [
    "audio/music/bed_path.txt",
    "audio/music/bed.wav",
    "audio/music/bed.mp3",
    "audio/speech/cue_0.wav",
  ]) {
    try {
      await ensureAbsRunFile(path.join(runDir(run.id), rel));
    } catch {
      /* optional */
    }
  }
  const bedHint = path.join(musicDir, "bed_path.txt");
  let musicPath: string | null = null;
  if (fs.existsSync(bedHint)) {
    const p = fs.readFileSync(bedHint, "utf8").trim();
    if (p) {
      try {
        await ensureAbsRunFile(p);
      } catch {
        /* ignore */
      }
      if (fs.existsSync(p)) musicPath = p;
    }
  }
  if (!musicPath) {
    for (const name of ["bed.wav", "bed.mp3"]) {
      const p = path.join(musicDir, name);
      if (fs.existsSync(p) && fs.statSync(p).size > 256) {
        musicPath = p;
        break;
      }
    }
  }
  if (!musicPath) throw new Error("Lyria bed missing for mix");

  if (plan.music_only) {
    await exportMusicOnlyMaster(run, plan, musicPath);
    return;
  }

  const speechPath = path.join(speechDir, "cue_0.wav");
  const speechStart = plan.cues[0]?.start ?? 0;
  const musicDur = plan.target_duration;
  const fadeOut = Math.min(4, Math.max(1.5, musicDur * 0.04));

  const bits = plan.wav_bit_depth === 24 ? 24 : 16;
  const pcm = bits === 24 ? "pcm_s24le" : "pcm_s16le";
  const cleanWav = path.join(runDir(run.id), "final_clean.wav");
  const syncedWav = path.join(runDir(run.id), "final_synced.wav");
  const previewWav = path.join(runDir(run.id), "final_preview.wav");
  const syncedM4a = path.join(runDir(run.id), "final.m4a");
  const outWav = path.join(runDir(run.id), "final.wav");

  await updateRun(run.id, {
    status: "stitching",
    error: `Rendering instrumental WAV (44.1 / ${bits}-bit)…`,
  });
  await ffmpegWavMaster(musicPath, cleanWav, {
    duration: musicDur,
    fadeOutSec: fadeOut,
    bitDepth: bits,
  });

  let syncedDur = musicDur;
  if (fs.existsSync(speechPath)) {
    const speechProbe = await probeFile(speechPath);
    const speechLen = speechProbe.duration ?? 0;
    syncedDur = Math.max(musicDur, speechStart + speechLen);
    // Memory-card window for Alphabet Jungle–style briefs.
    if (plan.dual_masters && plan.preview_cut_sec) {
      syncedDur = Math.min(Math.max(syncedDur, 65), 70);
    }
  }

  // Faded bed, then silence-pad to synced length so mixAudioMaster's loop can't restart the cue.
  const mixBed = path.join(musicDir, "bed_mix.wav");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      musicPath,
      "-t",
      musicDur.toFixed(3),
      "-af",
      `afade=t=out:st=${(musicDur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)},apad=whole_dur=${syncedDur.toFixed(3)}`,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      pcm,
      mixBed,
    ],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );

  await updateRun(run.id, {
    status: "stitching",
    error: plan.use_provided_speech
      ? "Overlay guide vocal + Lyria…"
      : "Overlay TTS + Lyria…",
  });

  const speech =
    fs.existsSync(speechPath) && fs.statSync(speechPath).size > 256
      ? [{ path: speechPath, start: speechStart }]
      : [];

  await mixAudioMaster({
    speech,
    musicPath: mixBed,
    duration: syncedDur,
    output: syncedM4a,
  });
  await ffmpegWavMaster(syncedM4a, syncedWav, { bitDepth: bits });
  fs.copyFileSync(syncedWav, outWav);

  if (plan.preview_cut_sec && plan.preview_cut_sec > 0) {
    await ffmpegWavMaster(syncedWav, previewWav, {
      duration: plan.preview_cut_sec,
      fadeOutSec: Math.min(1.2, plan.preview_cut_sec * 0.12),
      bitDepth: bits,
    });
  }

  const probe = await probeFile(syncedM4a);
  fs.writeFileSync(
    path.join(runDir(run.id), "audio_mix_report.json"),
    JSON.stringify(
      {
        probe,
        musicPath,
        cleanWav,
        syncedWav,
        previewWav: plan.preview_cut_sec ? previewWav : null,
        dual: plan.dual_masters,
        preview_cut_sec: plan.preview_cut_sec ?? null,
        wav_bit_depth: bits,
        useProvidedSpeech: plan.use_provided_speech,
        mode: "gemini-native",
        tts: plan.use_provided_speech ? "provided-guide" : AUDIO_TTS_MODEL,
        music: AUDIO_MUSIC_MODEL,
        extract: AUDIO_EXTRACT_MODEL,
      },
      null,
      2,
    ),
  );

  await exportAudioMasters(run, plan, {
    cleanWav,
    syncedWav,
    syncedM4a,
    previewWav: plan.preview_cut_sec ? previewWav : undefined,
  });
}

async function exportAudioMasters(
  run: RunRow,
  plan: AudioPlan,
  files: { cleanWav: string; syncedWav: string; syncedM4a: string; previewWav?: string },
): Promise<void> {
  await updateRun(run.id, { error: "Exporting audio master(s)…" });
  ensureDatasetLayout();
  const fresh = (await getRun(run.id))!;
  const metas: MetaRecord[] = [];
  const modelName = plan.use_provided_speech
    ? `${AUDIO_EXTRACT_MODEL}+provided-guide+${AUDIO_MUSIC_MODEL}`
    : `${AUDIO_EXTRACT_MODEL}+${AUDIO_TTS_MODEL}+${AUDIO_MUSIC_MODEL}`;

  const pushWav = async (abs: string, suffix: string, desc: string, tags: string[]) => {
    const rel = copyIntoDataset(abs, `audio/agent_generated/${fresh.session_id}_${suffix}.wav`);
    const uniq = exportUniqId(fresh.session_id, suffix);
    const dur = (await probeFile(abs)).duration ?? plan.target_duration;
    const meta: MetaRecord = {
      uniq_id: uniq,
      modality: "audio",
      generation_type: "agent_audio",
      media_id: path.basename(rel),
      media_desc: desc,
      media_path: rel,
      format: "wav",
      width: 1,
      height: 1,
      duration: dur,
      fps: null,
      resolution: null,
      prompt: fresh.initial_prompt.slice(0, 2000),
      model_name: modelName,
      category: fresh.category,
      tags,
      session_id: fresh.session_id,
      round_index: null,
      parent_uniq_id: null,
      audio_path: rel,
      origin_media_id: null,
      origin_media_path: null,
      mask_path: null,
      reference_images: [],
      ext_json: {
        source_platform: "Internal Pipeline",
        content_safety: "pass",
        visual_style: plan.music.prompt.slice(0, 200),
      },
    };
    metas.push(meta);
    await upsertAsset({
      uniq_id: uniq,
      run_id: fresh.id,
      shot_index: null,
      role: "stitch",
      path: rel,
      parent_uniq_id: null,
      meta_json: JSON.stringify(meta),
    });
  };

  if (plan.dual_masters) {
    await pushWav(files.syncedWav, "full_demo_mix", `${plan.media_desc} (full demo mix)`, [
      "audio",
      "lyria",
      "full-mix",
      "demo",
      "gemini-native",
    ]);
    await pushWav(files.cleanWav, "instrumental_singalong", `${plan.media_desc} (instrumental singalong)`, [
      "audio",
      "lyria",
      "instrumental",
      "singalong",
      "gemini-native",
    ]);
    if (files.previewWav && fs.existsSync(files.previewWav)) {
      await pushWav(
        files.previewWav,
        "preview_15s",
        `${plan.media_desc} (15-second preview cut)`,
        ["audio", "lyria", "preview", "15s", "gemini-native"],
      );
    }
  } else {
    // Keep m4a + wav for single radio spots.
    const m4aRel = copyIntoDataset(
      files.syncedM4a,
      `audio/agent_generated/${fresh.session_id}_final.m4a`,
    );
    copyIntoDataset(files.syncedWav, `audio/agent_generated/${fresh.session_id}_final.wav`);
    const uniq = exportUniqId(fresh.session_id, "audio_final");
    const dur = (await probeFile(files.syncedM4a)).duration ?? plan.target_duration;
    const meta: MetaRecord = {
      uniq_id: uniq,
      modality: "audio",
      generation_type: "agent_audio",
      media_id: path.basename(m4aRel),
      media_desc: plan.media_desc,
      media_path: m4aRel,
      format: "m4a",
      width: 1,
      height: 1,
      duration: dur,
      fps: null,
      resolution: null,
      prompt: fresh.initial_prompt.slice(0, 2000),
      model_name: `${AUDIO_EXTRACT_MODEL}+${AUDIO_TTS_MODEL}+${AUDIO_MUSIC_MODEL}`,
      category: fresh.category,
      tags: ["audio", "tts", "lyria", "gemini-native"],
      session_id: fresh.session_id,
      round_index: null,
      parent_uniq_id: null,
      audio_path: m4aRel,
      origin_media_id: null,
      origin_media_path: null,
      mask_path: null,
      reference_images: [],
      ext_json: {
        source_platform: "Internal Pipeline",
        content_safety: "pass",
        visual_style: plan.music.prompt.slice(0, 200),
      },
    };
    metas.push(meta);
    await upsertAsset({
      uniq_id: uniq,
      run_id: fresh.id,
      shot_index: null,
      role: "stitch",
      path: m4aRel,
      parent_uniq_id: null,
      meta_json: JSON.stringify(meta),
    });
  }

  const written = await withCatalogLock(() => {
    const result = appendMetaJsonl(metas);
    if (!result.ok) return result;
    writeSessionDeliveryJson(fresh.session_id, metas);
    return result;
  });
  if (!written.ok) throw new Error(written.errors.join("; "));
  writeDatasetInfo();

  await updateRun(fresh.id, {
    status: "exported",
    counted: 0,
    gate: null,
    error: null,
  });
}
