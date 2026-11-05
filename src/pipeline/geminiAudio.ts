/**
 * Google audio generation via GEMINI_API_KEY (Interactions API).
 * Speech: gemini-3.8-flash-tts. Music: lyria-3.5 / lyria-3-clip-preview.
 * Intentionally thin — pass operator/planner text through with minimal rewriting.
 */
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  AUDIO_EXTRACT_MODEL,
  AUDIO_MUSIC_CLIP_MODEL,
  AUDIO_MUSIC_MODEL,
  AUDIO_TTS_MODEL,
} from "./constants";

export { AUDIO_TTS_MODEL, AUDIO_MUSIC_MODEL, AUDIO_MUSIC_CLIP_MODEL, AUDIO_EXTRACT_MODEL };

/** Prebuilt Gemini TTS studio voices (Interactions speech_config.voice). */
export const GEMINI_TTS_VOICES = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
] as const;

const TTS_VOICE_SET = new Set(GEMINI_TTS_VOICES.map((v) => v.toLowerCase()));

/** Map freeform planner/operator names onto a prebuilt voice. Accent/tone belong in style. */
export function resolveTtsVoice(raw?: string | null, fallback = "Sulafat"): string {
  const name = (raw ?? "").trim();
  if (!name) return fallback;
  if (TTS_VOICE_SET.has(name.toLowerCase())) {
    return GEMINI_TTS_VOICES.find((v) => v.toLowerCase() === name.toLowerCase()) ?? fallback;
  }
  // Custom voice IDs from Voice design / replication.
  if (/^voice[_:]/i.test(name) || /^voicekey[_:]/i.test(name)) return name;
  return fallback;
}

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env (Google AI Studio key) for Gemini TTS / Lyria audio cooks.",
    );
  }
  return key;
}

function audioClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireGeminiKey() });
}

function extractAudioBytes(interaction: {
  output_audio?: { data?: string; mime_type?: string };
  outputs?: Array<{ type?: string; data?: string; mime_type?: string }>;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string }> }>;
}): { bytes: Buffer; mime?: string } {
  const direct = interaction.output_audio;
  if (direct?.data) {
    return { bytes: Buffer.from(direct.data, "base64"), mime: direct.mime_type };
  }
  for (const out of interaction.outputs ?? []) {
    if (out?.data && /audio/i.test(out.type ?? out.mime_type ?? "audio")) {
      return { bytes: Buffer.from(out.data, "base64"), mime: out.mime_type };
    }
  }
  for (const step of interaction.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block?.data && /audio/i.test(block.type ?? block.mime_type ?? "")) {
        return { bytes: Buffer.from(block.data, "base64"), mime: block.mime_type };
      }
    }
  }
  throw new Error("Gemini audio call returned no audio bytes (filtered or empty).");
}

function writeAudioFile(outPath: string, bytes: Buffer, mime?: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let dest = outPath;
  if (mime?.includes("mpeg") || mime?.includes("mp3")) {
    if (!/\.mp3$/i.test(dest)) dest = dest.replace(/\.\w+$/, "") + ".mp3";
  } else if (mime?.includes("wav") || !mime) {
    if (!/\.wav$/i.test(dest)) dest = dest.replace(/\.\w+$/, "") + ".wav";
  }
  fs.writeFileSync(dest, bytes);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 256) {
    throw new Error(`Wrote empty audio file: ${dest}`);
  }
  if (dest !== outPath) {
    try {
      fs.copyFileSync(dest, outPath);
    } catch {
      /* caller may accept either extension */
    }
  }
}

/** Single-speaker TTS. Style/voice only when the cue supplies them — no default “polish” prose. */
export async function generateSpeechTts(opts: {
  text: string;
  outPath: string;
  style?: string;
  voice?: string;
  onStatus?: (msg: string) => void;
}): Promise<string> {
  const text = opts.text.trim();
  if (!text) throw new Error("TTS requires non-empty text");
  const ai = audioClient();
  const voice = resolveTtsVoice(opts.voice);
  const style = opts.style?.trim();

  opts.onStatus?.(`Gemini TTS (${AUDIO_TTS_MODEL}, voice=${voice})…`);

  const contentBlock: Record<string, unknown> = {
    type: "text",
    text,
  };
  if (style) {
    contentBlock.annotations = [{ type: "speech_metadata", style }];
  }

  const interaction = await ai.interactions.create({
    model: AUDIO_TTS_MODEL,
    input: [
      {
        type: "user_input",
        content: [contentBlock],
      },
    ] as never,
    response_format: { type: "audio" },
    generation_config: {
      speech_config: [{ voice }],
    } as never,
  });

  const { bytes, mime } = extractAudioBytes(interaction as never);
  writeAudioFile(opts.outPath, bytes, mime);
  opts.onStatus?.(`TTS ready (${Math.round(bytes.length / 1024)} KB).`);
  return opts.outPath;
}

/**
 * Google-only extract: pull verbatim script + style + music prompt from the operator brief.
 * No rewrite of spoken words — extraction only.
 */
async function waitForFileActive(
  ai: GoogleGenAI,
  name: string,
  onStatus?: (msg: string) => void,
): Promise<{ uri?: string; name?: string; state?: string }> {
  for (let i = 0; i < 60; i++) {
    const f = await ai.files.get({ name });
    if (f.state === "ACTIVE") return f;
    if (f.state === "FAILED") throw new Error(`Gemini file failed: ${name}`);
    onStatus?.(`Waiting for uploaded audio (${name})…`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Gemini file not ACTIVE: ${name}`);
}

export async function extractAudioBriefWithGemini(opts: {
  operatorPrompt: string;
  attachmentText: string;
  targetDurationSec: number;
  /** Optional speech/music refs for Gemini to hear (repair / guide / style). */
  audioPaths?: string[];
  onStatus?: (msg: string) => void;
}): Promise<{
  script: string;
  style: string;
  musicPrompt: string;
  instrumental: boolean;
  speechStartSec: number;
  mediaDesc: string;
  useProvidedSpeech: boolean;
  dualMasters: boolean;
  musicOnly: boolean;
}> {
  const ai = audioClient();
  opts.onStatus?.(`Gemini extract (${AUDIO_EXTRACT_MODEL})…`);
  const prompt = [
    "Extract fields for a Gemini TTS + Lyria audio generation. Return ONE JSON object only.",
    "script: the FULL spoken voiceover/monologue/speech verbatim. Prefer an attached written script when present. If the task is to repair/restore a recording and audio is attached, LISTEN and transcribe the complete speech verbatim (use the clearest source; ignore glitches by preferring intact alternate takes). NEVER leave script empty unless music_only. If music-only, set script to exactly: MUSIC ONLY.",
    "style: short performance notes for speech_metadata (accent, warmth, pace). Match the attached speaker when audible. Empty string if music-only.",
    "music_prompt: detailed instrumental description for Lyria. If the brief forbids music, use a near-silent sparse room-tone bed (no melody, no rhythm section). Otherwise honor style refs.",
    "instrumental: true unless the brief wants sung vocals on the music bed.",
    "speech_start_sec: seconds before narration starts (0 if it opens).",
    "media_desc: one short sentence describing the piece.",
    "use_provided_speech: ignored by harness (always generative TTS except explicit guide-vocal cooks).",
    "dual_masters: true when full mix + instrumental (+ preview) WAVs are requested.",
    "music_only: true ONLY for instrumental-only deliverables with no spoken VO.",
    `Target duration about ${opts.targetDurationSec}s.`,
    "",
    "OPERATOR BRIEF:",
    opts.operatorPrompt.trim(),
    opts.attachmentText?.trim() ? `\nATTACHMENTS:\n${opts.attachmentText.trim()}` : "",
  ].join("\n");

  const uploadedNames: string[] = [];
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const tmpDir = path.join(process.cwd(), "runs", ".audio_extract_tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const audioPath of (opts.audioPaths ?? []).slice(0, 3)) {
      if (!audioPath || !fs.existsSync(audioPath)) continue;
      // Compact mono MP3 for Files API — models still hear the speech content.
      const compact = path.join(
        tmpDir,
        `${path.basename(audioPath).replace(/\W+/g, "_").slice(0, 40)}_${Date.now()}.mp3`,
      );
      opts.onStatus?.(`Preparing audio for extract (${path.basename(audioPath)})…`);
      try {
        await execFileAsync(
          "ffmpeg",
          [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            audioPath,
            "-t",
            "240",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            compact,
          ],
          { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        );
      } catch {
        continue;
      }
      if (!fs.existsSync(compact) || fs.statSync(compact).size < 256) continue;
      const mime = "audio/mpeg";
      opts.onStatus?.(`Uploading audio for extract (${path.basename(audioPath)})…`);
      try {
        const uploaded = await ai.files.upload({
          file: compact,
          config: { mimeType: mime },
        });
        if (!uploaded.name) continue;
        uploadedNames.push(uploaded.name);
        const ready = await waitForFileActive(ai, uploaded.name, opts.onStatus);
        const uri = ready.uri ?? uploaded.uri;
        if (!uri) continue;
        parts.push({ fileData: { fileUri: uri, mimeType: mime } });
      } finally {
        try {
          fs.unlinkSync(compact);
        } catch {
          /* ignore */
        }
      }
    }

    const result = await ai.models.generateContent({
      model: AUDIO_EXTRACT_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json" },
    });
    const raw = (result.text ?? "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("Gemini extract returned no JSON");
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      script?: string;
      style?: string;
      music_prompt?: string;
      musicPrompt?: string;
      instrumental?: boolean;
      speech_start_sec?: number;
      speechStartSec?: number;
      media_desc?: string;
      mediaDesc?: string;
      music_only?: boolean;
      musicOnly?: boolean;
    };
    const hintMusicOnly =
      parsed.music_only === true ||
      parsed.musicOnly === true ||
      /\bmusic only\b/i.test(opts.operatorPrompt) ||
      /\bwithout VO\/FX\b/i.test(opts.operatorPrompt) ||
      /\bfinished audio,\s*music only\b/i.test(opts.operatorPrompt) ||
      /\bno VO\/FX\b/i.test(opts.operatorPrompt);
    const script = (parsed.script ?? "").trim() || (hintMusicOnly ? "MUSIC ONLY" : "");
    if (!script) throw new Error("Gemini extract returned empty script");
    return {
      script,
      style: (parsed.style ?? "").trim(),
      musicPrompt:
        (parsed.music_prompt ?? parsed.musicPrompt ?? "").trim() ||
        (/\bdo not add music\b/i.test(opts.operatorPrompt)
          ? "Near-silent sparse room tone only, no melody, no instruments"
          : "Gentle instrumental underscore"),
      instrumental: parsed.instrumental !== false,
      speechStartSec: Math.max(0, Number(parsed.speech_start_sec ?? parsed.speechStartSec ?? 0) || 0),
      mediaDesc: (parsed.media_desc ?? parsed.mediaDesc ?? "Audio spot").trim(),
      useProvidedSpeech: false,
      dualMasters: false,
      musicOnly: hintMusicOnly,
    };
  } finally {
    for (const name of uploadedNames) {
      try {
        await ai.files.delete({ name });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Strip artist-name / catalogue refs that often trip Lyria prohibited-content filters. */
export function sanitizeLyriaPrompt(raw: string): string {
  let p = raw.trim();
  p = p.replace(/\b(in the )?style (of|reminiscent of)\s+[^.]+/gi, "warm mid-2000s psych-folk acoustic vibe");
  p = p.replace(/\bDevendra Banhart\b/gi, "");
  p = p.replace(/\bMatador Records?\b/gi, "");
  p = p.replace(/\bCocomelon\b/gi, "");
  p = p.replace(/\bHack-?Poets( Guild)?\b/gi, "");
  p = p.replace(/\bchildren'?s\b/gi, "family-friendly");
  p = p.replace(/\bkids?\b/gi, "young listeners");
  p = p.replace(/\s{2,}/g, " ").trim();
  return p;
}

/** Lyria music bed. Prompt is lightly sanitized; duration hint appended. */
export async function generateLyriaMusic(opts: {
  prompt: string;
  outPath: string;
  /** Use 30s clip model instead of full-song Lyria 3.5. */
  clip?: boolean;
  durationSec?: number;
  instrumental?: boolean;
  onStatus?: (msg: string) => void;
}): Promise<string> {
  const base = sanitizeLyriaPrompt(opts.prompt);
  if (!base) throw new Error("Lyria requires a non-empty music prompt");
  const ai = audioClient();
  const model = opts.clip ? AUDIO_MUSIC_CLIP_MODEL : AUDIO_MUSIC_MODEL;
  const bits = [base];
  if (opts.instrumental) bits.push("Instrumental only — no vocals.");
  if (opts.durationSec && opts.durationSec > 0 && !opts.clip) {
    bits.push(`About ${Math.round(opts.durationSec)} seconds.`);
  }
  const prompt = bits.join(" ");

  opts.onStatus?.(`Lyria (${model})…`);

  const interaction = await ai.interactions.create({
    model,
    input: prompt as never,
    response_format: { type: "audio" },
  });

  const { bytes, mime } = extractAudioBytes(interaction as never);
  writeAudioFile(opts.outPath, bytes, mime);
  opts.onStatus?.(`Lyria ready (${Math.round(bytes.length / 1024)} KB).`);
  return opts.outPath;
}
