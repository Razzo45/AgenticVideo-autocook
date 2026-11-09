import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  BRAIN_MODEL,
  CATEGORIES,
  MAX_DURATION_AUTO_SHORT_SEC,
  PRODUCT_VIDEO_MODEL,
  VARIANT_COUNT_DEFAULT,
  deliveryFpsFromPrompt,
  durationBounds,
  imageDimensionsForAspect,
  normalizeOutputResolution,
  omniNativeAspect,
  type Category,
  type OutputResolution,
  type PipelineMode,
  type VideoAspect,
  isDocPipelineMode,
} from "./constants";
import { loadModelsConfig } from "./config";
import { runDir } from "./paths";
import { checklistComplete, scriptPlanSchema, type Checklist, type MetaRecord, type ScriptPlan, type ShotTransition } from "./schema";
import {
  deleteRunRows,
  enqueueJob,
  findRunByRequestId,
  finishJob,
  getDb,
  getReview,
  getRun,
  rememberCookRequest,
  getVariant,
  insertRun,
  insertVariant,
  listAssets,
  listVariants,
  listWaitingRuns,
  rejectBatch,
  runHasBusyJobs,
  selectVariant,
  sessionIdTaken,
  updateRun,
  upsertAsset,
  upsertReview,
  type JobRow,
  type RunRow,
} from "../db";
import {
  generateImage,
  generateVideo,
  inspectVideoModel,
  isVideoCapacityError,
  isVideoFilterError,
  isGraphicCardPrompt,
  minimalTalkingHeadPrompt,
  snapDuration,
} from "./openrouter";
import { brainCompletion } from "./geminiBrain";
import { isOmniModel } from "./geminiOmni";
import {
  buildInsertClip,
  conformExactDelivery,
  detectBlackBars,
  extractAudio,
  extractFirstFrame,
  extractLastFrameKeyframe,
  extractVideoReferenceStills,
  mixMusicBed,
  overlayLogoBug,
  probeFile,
  stillToClip,
  trimClip,
  stitchSession,
} from "./stitch";
import { findMusicBed, prepareRunInputs } from "./inputPrep";
import {
  evaluateClip,
  evaluateImage,
  evaluateStitch,
  validateMetaRecord,
  canExport,
  AUTO_SOFT_STITCH_IDS,
} from "./conformance";
import {
  clearLocalRunCache,
  deleteRunPrefix,
  ensureAbsRunFile,
  persistRunFile,
  persistRunTree,
  storageMode,
} from "./storage";
import { sanitizeFinishedRun } from "./hygiene";
import {
  autoOptionsFromRun,
  autoRequirementsPrompt,
  isLikelyPresenterStill,
  parseAutoOptions,
  type AutoOptions,
} from "./autoOptions";
import {
  appendAntiPrompt,
  formatAntiPromptSidecar,
  selectAntiPromptSidecar,
  storyboardTooClose,
} from "./antiprompt";
import {
  classifyOperatorVideoRole,
  filenameWords,
  formatInputsForScript,
  isLikelyTitleGraphicAsset,
  isLikelyTrademarkAsset,
  operatorAudioAssets,
  operatorBookendVideos,
  operatorModelImageRefs,
  parseRunInputs,
  saveRunInputs,
  type RunInputAsset,
  type RunInputFile,
} from "./inputs";
import { buildDirectScriptPlan } from "./scriptDirect";
import {
  isAudioRun,
  jobAudioAssemble,
  jobAudioMix,
  jobAudioMusic,
  jobAudioPlan,
  jobAudioSpeech,
  parseAudioPlan,
} from "./audioPipeline";
import { isDocRun, jobDocCook, resolveDocFinalPath } from "./docPipeline";
import { jobArgonPlan, jobArgonTask, loadTaskDeliverables } from "./argonTask";
import { withGeminiOwner } from "./geminiAdmission";
import {
  appendMetaJsonl,
  copyIntoDataset,
  ensureDatasetLayout,
  purgeSessionFromDataset,
  withCatalogLock,
  writeDatasetInfo,
  writeSessionDeliveryJson,
} from "./export";
import { exportUniqId, previewSessionId } from "./session";

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

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function runOutputResolution(run: RunRow): OutputResolution {
  return normalizeOutputResolution(run.output_resolution);
}

/** Non-logo stills + frames from generic reference videos (not intro/outro / title plates). */
/** Video models cap how many videos they take; the plate to edit must be among them. */
function mainPlateFirst(paths: string[]): string[] {
  const rank = (p: string) => (/\b(main|plate|master|base)\b/.test(filenameWords(path.basename(p))) ? 0 : 1);
  return [...paths].sort((a, b) => rank(a) - rank(b));
}

async function operatorVisualRefs(
  run: RunRow,
  opts?: { maxVideoStills?: number; preferPresenter?: boolean },
): Promise<{
  imagePaths: string[];
  videoPaths: string[];
  audioPaths: string[];
}> {
  // Logo/title PNGs are stitch/prompt-only — avoid trademark blocks and filename burn-in.
  let imagePaths = [...operatorModelImageRefs(run.input_assets_json)];
  if (opts?.preferPresenter) {
    const assets = parseRunInputs(run.input_assets_json);
    const portraits = assets
      .filter((a) => a.kind === "image" && isLikelyPresenterStill(a.filename) && fs.existsSync(a.path))
      .map((a) => a.path);
    if (portraits.length) {
      imagePaths = [...portraits, ...imagePaths.filter((p) => !portraits.includes(p))];
    }
  }
  const videos = operatorBookendVideos(run.input_assets_json);
  // Intro/outro plates and insert sources are cut in at stitch; their frames would make the
  // generator redraw them (e.g. a fake UI behind the presenter).
  const insertSources = new Set(
    (run.script_json ? (JSON.parse(run.script_json) as ScriptPlan).shots : [])
      .map((s) => s.insert?.source?.trim().toLowerCase())
      .filter(Boolean),
  );
  const styleVideos = videos.references.filter((p) => {
    const asset = parseRunInputs(run.input_assets_json).find((a) => a.path === p);
    return !asset || !insertSources.has(asset.filename.toLowerCase());
  });
  const frameDir = path.join(runDir(run.id), "inputs", "video_frames");
  const maxStills = opts?.maxVideoStills ?? 6;
  let stillBudget = maxStills;
  for (const vid of styleVideos) {
    if (stillBudget <= 0) break;
    const take = Math.min(2, stillBudget);
    const stills = await extractVideoReferenceStills(vid, frameDir, { maxStills: take });
    imagePaths.push(...stills);
    stillBudget -= stills.length;
  }
  const musicBed = await findMusicBed(run.input_assets_json);
  return {
    imagePaths: [...new Set(imagePaths)],
    videoPaths: styleVideos,
    // Music/SFX beds are for stitch/mix guidance — do not upload huge beds as Veo audio refs
    // (slow submits + long pending). Voice-sample filenames still pass through when present.
    audioPaths: operatorAudioAssets(run.input_assets_json)
      .filter((a) => a.id !== musicBed?.id)
      .filter((a) => !/\b(music|bed|score|whoosh|sfx|stinger|underscore)\b/i.test(filenameWords(a.filename)))
      .map((a) => a.path),
  };
}

function operatorRefsPromptSuffix(
  run: RunRow,
  shot?: { image_prompt?: string; motion_prompt?: string; media_desc?: string },
): string {
  const autoExtra = () =>
    isAutoRun(run) ? autoRequirementsPrompt(autoOptionsFromRun(run), { shot }).trim() : "";

  const assets = parseRunInputs(run.input_assets_json);
  if (!assets.some((a) => a.kind === "image" || a.kind === "video" || a.kind === "audio")) {
    const extra = autoExtra();
    return extra ? `\n${extra}` : "";
  }
  const shotBlob = [shot?.image_prompt, shot?.motion_prompt, shot?.media_desc].filter(Boolean).join("\n");
  const shotForbidsGraphics =
    /\b(no on-screen text|no title cards?|talking-head only|no logos?|no lower thirds?)\b/i.test(shotBlob);
  const isOmni = isOmniModel(run.video_model);
  const hasLogo = assets.some((a) => a.kind === "image" && isLikelyTrademarkAsset(a.filename));
  const hasTitle = assets.some(
    (a) =>
      (a.kind === "image" && isLikelyTitleGraphicAsset(a.filename)) ||
      (a.kind === "video" && classifyOperatorVideoRole(a.filename) === "intro"),
  );
  const hasFootage = assets.some(
    (a) => a.kind === "video" && classifyOperatorVideoRole(a.filename) === "reference",
  );
  const hasAudio = assets.some((a) => a.kind === "audio");
  const hasBookend = assets.some(
    (a) => a.kind === "video" && classifyOperatorVideoRole(a.filename) !== "reference",
  );

  const lines = [
    "",
    "OPERATOR ASSETS for THIS run (roles only — never invent other brands or jobs):",
  ];
  if (hasFootage) {
    lines.push(
      isOmni
        ? "Reference footage: match the look and setting of the attached plates when the brief uses them."
        : "Reference footage: match look, location, wardrobe, and people from those plates when the brief uses them.",
    );
    if (!isOmni) {
      lines.push(
        "When people appear on screen, their faces, ages, hair, and bodies must match the attached reference footage plates — do not invent lookalikes or substitute different people.",
      );
    }
  }
  if (hasAudio) {
    lines.push("Music/SFX bed is attached — follow the brief for mix; do not invent a different soundtrack.");
  }
  if (!shotForbidsGraphics && (hasTitle || hasBookend)) {
    lines.push(
      "Attached title / intro / outro graphic packages MUST appear in the finished video (intro/outro plates are bookended in the final stitch). Match their look when the brief calls for on-screen titles — do not invent a different title package.",
    );
  }
  if (hasLogo) {
    lines.push(
      shotForbidsGraphics
        ? "Logo files are for stitch later — do NOT render logos or wordmarks in this take."
        : isOmni
          ? "Logo/mark files are stitch/prompt guidance — on-screen branding only if the brief asks."
          : "Logo/mark files are stitch/prompt guidance (many models block trademark image refs) — on-screen branding only if the brief asks.",
    );
  }
  lines.push("CRITICAL: Never render filenames, file extensions, folder paths, or asset labels as on-screen text.");
  if (isOmni && hasFootage) {
    lines.push("Keep the real on-screen interface from the reference footage. No watermarks or metadata overlays.");
  } else {
    lines.push(
      shotForbidsGraphics
        ? "No UI chrome, watermarks, logos, or metadata overlays in this take."
        : "No UI chrome, watermarks, or metadata overlays unless the brief explicitly requires designed titles.",
    );
  }
  if (isAutoRun(run)) {
    const extra = autoExtra();
    if (extra) lines.push(extra.replace(/^\n+/, ""));
  }
  return lines.join("\n");
}

export async function createRun(input: {
  prompt: string;
  category: Category;
  duration: number;
  aspect: VideoAspect;
  scriptModel?: string;
  keyframeModel?: string;
  videoModel?: string;
  sessionLabel?: string;
  inputFiles?: RunInputFile[];
  pipelineMode?: PipelineMode;
  operatorScript?: string;
  outputResolution?: OutputResolution;
  autoOptions?: Partial<AutoOptions> | AutoOptions;
  /** GDP-style idempotency key — retries return the same run instead of double-billing. */
  requestId?: string;
  userId?: string;
  tenantId?: string | null;
  createdByKind?: string;
}): Promise<RunRow> {
  const userId = (input.userId ?? "local-dev").trim() || "local-dev";
  const tenantId = input.tenantId?.trim() || null;
  const createdByKind = input.createdByKind ?? "dev";
  if (input.requestId?.trim()) {
    const existing = await findRunByRequestId(input.requestId, userId);
    if (existing) return existing;
  }
  if (!CATEGORIES.includes(input.category)) throw new Error("Unknown category");
  const mode = input.pipelineMode ?? "auto";
  const autoOpts = mode === "auto" ? parseAutoOptions(input.autoOptions ?? {}) : null;
  let outputResolution = normalizeOutputResolution(input.outputResolution);
  if (autoOpts?.deliver4k) outputResolution = "4K";
  // Heuristic auto uses durationBounds (e.g. ~30s min for multi-scene cooks).
  // Autocook brain is always Argon — ignore UI / OpenRouter script slugs.
  const scriptModel = BRAIN_MODEL;
  const bounds = durationBounds(mode);
  let duration = Math.min(bounds.max, Math.max(bounds.min, input.duration));
  if (mode === "auto" && autoOpts && !autoOpts.longCook) {
    duration = Math.min(duration, MAX_DURATION_AUTO_SHORT_SEC);
  }
  if (mode === "direct") {
    const hasTextFile = input.inputFiles?.some((f) => /\.(md|txt|csv)$/i.test(f.originalName));
    if (!input.operatorScript?.trim() && !hasTextFile) {
      throw new Error("Direct pipeline requires a script in the textarea or a .md/.txt attachment.");
    }
  }
  const id = newId("run");
  const base = previewSessionId(input.category, input.prompt, input.sessionLabel);
  const sessionPrefix =
    mode === "direct"
      ? "direct-"
      : mode === "auto"
        ? "auto-"
        : mode === "audio"
          ? "audio-"
          : isDocPipelineMode(mode)
            ? `${mode}-`
            : "";
  let session = `${sessionPrefix}${base}`;
  for (let n = 2; (await sessionIdTaken(session)) && n < 1000; n++) {
    session = `${sessionPrefix}${base}-${n}`;
  }
  fs.mkdirSync(runDir(id), { recursive: true });
  const inputAssets: RunInputAsset[] = input.inputFiles?.length
    ? await saveRunInputs(id, input.inputFiles)
    : [];
  // Web disk is not shared with the worker — bucket holds inputs; drop local scratch.
  if (inputAssets.length && storageMode() === "s3") {
    clearLocalRunCache(id);
  }
  await insertRun({
    id,
    session_id: session,
    status: "queued",
    category: input.category,
    aspect_ratio: mode === "audio" || mode === "task" || isDocPipelineMode(mode) ? "16:9" : input.aspect,
    target_duration: duration,
    output_resolution: mode === "audio" || mode === "task" || isDocPipelineMode(mode) ? "1080p" : outputResolution,
    initial_prompt: input.prompt,
    script_model: scriptModel,
    keyframe_model: "omni:text_to_video",
    // Product cooks: Omni on GEMINI_API_KEY only — never accept UI/API overrides.
    video_model: mode === "audio" ? "google/gemini-tts+lyria" : PRODUCT_VIDEO_MODEL,
    current_shot_index: 0,
    rework_round: 0,
    gate: null,
    revise_comment: null,
    script_json: null,
    input_assets_json: inputAssets.length ? JSON.stringify(inputAssets) : null,
    pipeline_mode: mode,
    operator_script: input.operatorScript?.trim() || null,
    auto_options_json: autoOpts ? JSON.stringify(autoOpts) : null,
    error: null,
    counted: 0,
    user_id: userId,
    tenant_id: tenantId,
    created_by_kind: createdByKind,
  });
  if (mode === "task") {
    await enqueueJob(id, "argon_plan");
    await updateRun(id, { status: "queued", error: "Argon is reading the task…" });
  } else if (isDocPipelineMode(mode)) {
    await enqueueJob(id, "doc_cook");
    await updateRun(id, { status: "generating" });
  } else {
    await enqueueJob(id, mode === "audio" ? "audio_plan" : "script");
    await updateRun(id, { status: "generating" });
  }
  if (input.requestId?.trim()) await rememberCookRequest(input.requestId, id, userId);
  return (await getRun(id))!;
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Model did not return JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

/** Brief asks for a picture-only master with no audio stream. */
function briefWantsNoAudio(run: RunRow): boolean {
  return /\b(no audio|silent video|disable audio|without (any )?(sound|audio)|picture[- ]only|(do not|don't) include (any |an )?audio|no sound design)\b/i.test(
    run.initial_prompt ?? "",
  );
}

/** Technical master the brief asks for (codec / exact frame count), rendered next to the preview. */
function deliveryMasterSpec(run: RunRow): {
  codec: "h264" | "prores4444";
  ext: ".mov" | ".mp4";
  frames: number | null;
  size: { width: number; height: number } | null;
  /** When set, frame count comes from the single attached plate at stitch time. */
  matchPlateDuration: boolean;
} | null {
  const p = run.initial_prompt ?? "";
  let frames = Number(p.match(/\bexactly\s+(\d{2,6})\s+frames\b/i)?.[1] ?? 0);
  // "Exactly 00:01:17:22" — HH:MM:SS:FF at the delivery frame rate.
  const tc = p.match(/\bexactly\s+(\d{1,2}):(\d{2}):(\d{2}):(\d{2})\b/i);
  if (!frames && tc) {
    const fpsStr = deliveryFpsFromPrompt(p);
    const [n, d] = fpsStr.split("/").map(Number);
    const fps = d ? n! / d : Number(fpsStr) || 25;
    frames = Math.round((Number(tc[1]) * 3600 + Number(tc[2]) * 60 + Number(tc[3])) * fps) + Number(tc[4]);
  }
  // "Exactly 65.12 seconds" at the delivery frame rate.
  const exactSec = p.match(/\bexactly\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/i);
  if (!frames && exactSec) {
    const fpsStr = deliveryFpsFromPrompt(p);
    const [n, d] = fpsStr.split("/").map(Number);
    const fps = d ? n! / d : Number(fpsStr) || 25;
    frames = Math.round(Number(exactSec[1]) * fps);
  }
  const prores = /\bprores\s*4444\b/i.test(p);
  const silentMp4 =
    briefWantsNoAudio(run) && /\b(mp4|4k\s*uhd|uhd)\b/i.test(p) && /\b(full duration|no trims)\b/i.test(p);
  if (!frames && !prores && !silentMp4) return null;
  const dims =
    p.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/) ??
    (/\b4k\s*uhd\b/i.test(p) ? (["3840x2160", "3840", "2160"] as const) : null);
  return {
    codec: prores ? "prores4444" : "h264",
    ext: prores || (/\b(mov|quicktime)\b/i.test(p) && !silentMp4) ? ".mov" : ".mp4",
    frames: frames || null,
    size: dims ? { width: Number(dims[1]), height: Number(dims[2]) } : null,
    matchPlateDuration: silentMp4 && !frames,
  };
}

function deliveryMasterPath(run: RunRow): string | null {
  const spec = deliveryMasterSpec(run);
  return spec ? path.join(runDir(run.id), `final_master${spec.ext}`) : null;
}

async function runMusicBed(run: RunRow) {
  return briefWantsNoAudio(run) ? null : findMusicBed(run.input_assets_json);
}

/** Where this shot starts on the edit timeline — used to send each shot its own segment of a supplied plate. */
function shotStartSec(script: ScriptPlan, shotIndex: number): number {
  return script.shots.slice(0, shotIndex).reduce((s, x) => s + (x.duration ?? 0), 0);
}

/** Operator-specified in-point into the supplied plate ("performance that starts 5 seconds into the clip"). */
function plateInPointSec(run: RunRow): number {
  const p = run.initial_prompt ?? "";
  const m =
    p.match(/\b(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\s+into\s+(?:the\s+)?(?:\w+\s+){0,3}?(?:clip|footage|plate|video|take)\b/i) ??
    p.match(/\bstart(?:s|ing)?\s+at\s+(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/i);
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 && v < 600 ? v : 0;
}

/** Heuristic slot grid — used only by direct segmentation, not Argon auto. */
function planShotDurations(allowed: number[], minimumSec: number): number[] {
  const maxLen = allowed.length ? Math.max(...allowed) : 8;
  const count = Math.max(1, Math.ceil(Math.max(minimumSec, 1) / maxLen));
  const each = Math.max(minimumSec, 1) / count;
  const clipLen = [...allowed].sort((a, b) => a - b).find((d) => d >= each) ?? maxLen;
  return Array.from({ length: count }, () => clipLen);
}

/** Snap a planned clip length to the generator's allowed set — never invents extra scenes. */
function snapShotDuration(want: number, allowed: number[]): number {
  if (!allowed.length) return Math.max(1, Math.round(want) || 8);
  let best = allowed[0]!;
  let bestDist = Math.abs(want - best);
  for (const d of allowed) {
    const dist = Math.abs(want - d);
    if (dist < bestDist || (dist === bestDist && d > best)) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/** Stitch fps from Argon's plan when present; else parse the operator brief. */
function planDeliveryFps(run: RunRow, script: ScriptPlan | null): string {
  const fps = script?.delivery_fps;
  if (typeof fps === "number" && Number.isFinite(fps) && fps > 0) {
    const key = String(fps);
    const map: Record<string, string> = {
      "23.976": "24000/1001",
      "23.98": "24000/1001",
      "24": "24",
      "25": "25",
      "29.97": "30000/1001",
      "30": "30",
      "50": "50",
      "59.94": "60000/1001",
      "60": "60",
    };
    return map[key] ?? String(Math.round(fps));
  }
  return deliveryFpsFromPrompt(run.initial_prompt);
}

export async function processJob(job: JobRow): Promise<void> {
  const run = await getRun(job.run_id);
  if (!run) {
    await finishJob(job.id, "error", "Run deleted");
    return;
  }
  const payload = JSON.parse(job.payload_json || "{}") as { shotIndex?: number; sourceVariantId?: string };
  try {
    // GDP-style owner fairness: all Gemini calls in this job share run id.
    await withGeminiOwner(run.id, async () => {
      if (job.type === "argon_plan") await jobArgonPlan(run);
      else if (job.type === "argon_task" || job.type === "argon_execute") await jobArgonTask(run);
      else if (job.type === "doc_cook") await jobDocCook(run);
      else if (job.type === "audio_plan") await jobAudioPlan(run);
      else if (job.type === "audio_speech") await jobAudioSpeech(run);
      else if (job.type === "audio_music") await jobAudioMusic(run);
      else if (job.type === "audio_mix") await jobAudioMix(run);
      else if (job.type === "audio_assemble") await jobAudioAssemble(run);
      else if (job.type === "script") {
        if (run.pipeline_mode === "direct") await jobScriptDirect(run);
        else await jobScript(run);
      } else if (job.type === "keyframes") await jobKeyframes(run, payload.shotIndex ?? run.current_shot_index);
      else if (job.type === "clips") {
        const shotIndex = payload.shotIndex ?? run.current_shot_index;
        if (payload.sourceVariantId) await jobClipEdit(run, shotIndex, payload.sourceVariantId);
        else await jobClips(run, shotIndex);
      } else if (job.type === "stitch") await jobStitch(run);
      else if (job.type === "export") await jobExport(run);
      else throw new Error(`Unknown job ${job.type}`);
    });
    // Bucket is canonical — upload after every job. Keep local scratch until the run
    // finishes so the next step on this worker still sees keyframes/beds/clips.
    try {
      const n = await persistRunTree(run.id);
      if (n && storageMode() === "s3") {
        console.log(`[storage] committed ${n} file(s) → bucket for ${run.id} after ${job.type}`);
      }
    } catch (persistErr) {
      console.error(`[storage] commit after ${job.type} failed for ${run.id}`, persistErr);
    }
    await finishJob(job.id, "done");
    try {
      await advanceAutoRun(job.run_id);
    } catch (advErr) {
      const message = advErr instanceof Error ? advErr.message : String(advErr);
      if (await getRun(job.run_id)) await updateRun(job.run_id, { status: "failed", error: `Auto advance: ${message}` });
    }
    const after = await getRun(job.run_id);
    if (after && (after.status === "exported" || after.status === "failed" || after.status === "rejected")) {
      try {
        await persistRunTree(after.id);
        await sanitizeFinishedRun(after.id);
        if (storageMode() === "s3") clearLocalRunCache(after.id);
      } catch (sanErr) {
        console.error(`[storage] sanitizeFinishedRun ${after.id}`, sanErr);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fresh = await getRun(run.id);
  if (!fresh) throw new Error("Unknown run");
    // Auto cook: re-queue overload once is enough via generateVideo backoff — do not
    // spawn unbounded delayed jobs after a hard fail (billing risk).
    if (
      fresh &&
      isAutoRun(fresh) &&
      (isVideoCapacityError(message) || /overloaded|try again later|high load/i.test(message)) &&
      (job.type === "clips" || job.type === "keyframes")
    ) {
      await finishJob(job.id, "error", message);
      await updateRun(fresh.id, {
        status: "failed",
        gate: null,
        error: `Scene ${(payload.shotIndex ?? fresh.current_shot_index) + 1} stopped on provider overload (${job.type}). Earlier scenes kept. Resume retries only this scene — not auto-looping.`,
      });
      try {
        await persistRunTree(fresh.id);
        await sanitizeFinishedRun(fresh.id);
        if (storageMode() === "s3") clearLocalRunCache(fresh.id);
      } catch {
        /* best-effort */
      }
      return;
    }
    if (fresh) await updateRun(fresh.id, { status: "failed", error: message });
    await finishJob(job.id, "error", message);
    try {
      await persistRunTree(fresh.id);
      await sanitizeFinishedRun(fresh.id);
      if (storageMode() === "s3") clearLocalRunCache(fresh.id);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

async function jobScript(run: RunRow): Promise<void> {
  const auto = isAutoRun(run);
  await updateRun(run.id, { status: "generating", gate: null, error: "Writing storyboard…" });
  run = await prepareRunInputs(run, async (msg) => {
    await updateRun(run.id, { error: msg });
  });
  await updateRun(run.id, { error: "Writing storyboard…" });
  const footage = operatorBookendVideos(run.input_assets_json).references.length > 0;
  const musicBed = await runMusicBed(run);
  const footageRule = footage && isOmniModel(run.video_model)
    ? `
- SUPPLIED FOOTAGE: the attached videos are sent to the video model and it edits that footage directly. Each scene receives only its own segment of the footage — scene 1 from ${plateInPointSec(run)}s${plateInPointSec(run) > 0 ? " (the in-point named in the brief)" : ""}, each later scene starting where the previous scenes' durations end — so the scenes play back to back as one continuous take. Write each motion_prompt as the change to apply to that segment (what is added or altered, and what must stay as shot), timed to that segment and picking up exactly where the previous scene's action left off. Do not use inserts: "insert": null on every shot.`
    : footage
    ? `
- SUPPLIED FOOTAGE: attached videos with a VIDEO TIMELINE are real footage you can cut to. To show it, set "insert": {"source": "<exact attachment filename>", "start": <seconds>, "end": <seconds>} on that shot — the finished shot plays that segment's picture for the shot duration over the shot's generated audio. So an insert shot's image_prompt/motion_prompt still describe the presenter on camera speaking that moment's lines (that take supplies the voice). Use inserts wherever the brief or script calls for the supplied footage, matched to the timeline section being discussed. Never ask the generator to recreate supplied screens, interfaces or footage. Shots without footage: "insert": null.`
    : "";
  const musicRule = musicBed
    ? `
- MUSIC BED: "${musicBed.filename}" is mixed at the end, ducked beneath dialogue. motion_prompt must NOT ask for music, score, or soundtrack — dialogue, room tone and diegetic sound only. Set "music" on every shot: true where the bed plays under that shot, false where the brief wants the music out (e.g. music only on the opening and closing). If the brief does not say, true throughout.`
    : "";
  const hasLogoFile = parseRunInputs(run.input_assets_json).some(
    (a) => a.kind === "image" && isLikelyTrademarkAsset(a.filename),
  );
  const logoRule = hasLogoFile
    ? `
- LOGO BUG: the supplied logo file can be composited small in the top-right corner at the end. Set "logo_bug": true on shots where the brief wants the logo kept on screen (e.g. a corner logo through the main body), false on title cards, end cards and wherever the brief does not ask for it. On logo_bug shots, image_prompt and motion_prompt must not draw any logo — the real file is added later.`
    : "";
  const calloutRule = auto
    ? `
- CALLOUTS: You own on-screen reinforcement text. Put exact brief/script wording in "callout" on the shot it supports (null when none). The platform overlays it at edit — image_prompt and motion_prompt must not draw that text. Never give a callout its own scene. Set top-level "callout_color" to the brand's primary dark hex when guidelines give one, else null.
- You own scene count, timing, and which beats need graphics/logo — the platform does not invent extras.`
    : "";
  const sidecar = selectAntiPromptSidecar(run.category, run.initial_prompt);
  const videoInfo = await inspectVideoModel(run.video_model);
  if (videoInfo.supports1080p === false) {
    throw new Error(`Video model ${run.video_model} cannot emit 1080p and is not eligible.`);
  }
  const allowed = videoInfo.durations?.length ? videoInfo.durations : [8];
  const durationRule = auto
    ? `- YOU own the edit structure. Choose how many scenes the brief needs and each scene's duration. Every shot.duration MUST be one of these generator lengths: ${JSON.stringify(allowed)}. Aim for ~${run.target_duration}s total (± one clip). Cover the FULL brief in order — do not drop required sections. The platform only concatenates your scenes and applies overlays you marked.`
    : `- Requested length is a MINIMUM of ${run.target_duration}s. Prefer durations from ${JSON.stringify(allowed)}.`;
  const autoTransitionHint = auto
    ? `- SCENE ASSEMBLY: Prefer "continue" when the same presenter stays on-camera (hard join from previous last frame — no new still). Use "cut" for graphic inserts, B-roll, or clear scene changes.`
    : "";
  const deliveryRule = auto
    ? `- DELIVERY: Set top-level "delivery_fps" (number) and "delivery_resolution" ("1080p" or "4K") from the operator brief's export requirements. The platform finishes at those values and does not invent different ones.`
    : "";
  const system = `You write a production storyboard for an AIGC video pipeline — not a loose synopsis.
You are the sole planner: scene count, durations, transitions, callouts, logo bugs, and delivery fps/resolution. The platform only runs generators and post you specify — it must not add creative steps you omitted.
Mold cast, setting, tone, and visuals to THIS operator prompt and attachments. Do not assume a brand, presenter format, or house look.
Return ONLY JSON matching this shape:
{"media_desc":string,"tags":string[],"subjects":string[],"setting":string,"visual_style":string,"content_safety_notes":string,${auto ? '"callout_color":string|null,"delivery_fps":number|null,"delivery_resolution":"1080p"|"4K"|null,' : ""}"shots":[{"index":number,"duration":number,"transition":"cut"|"continue","image_prompt":string,"motion_prompt":string,"media_desc":string${footage ? ',"insert":{"source":string,"start":number,"end":number}|null' : ""}${musicBed ? ',"music":boolean' : ""}${hasLogoFile ? ',"logo_bug":boolean' : ""}${auto ? ',"callout":string|null' : ""}}]}
Rules:
- Category: ${run.category}. Aspect: ${run.aspect_ratio}.
${durationRule}
${deliveryRule}
${autoTransitionHint}${footageRule}${musicRule}${logoRule}${calloutRule}
- OPERATOR PROMPT IS THE STORY. Keep its cast, setting, tone, beats, and ending. Do not invent a different premise, swap the plot, or "improve" it into another genre.
- When OPERATOR ATTACHMENTS include spoken/dialogue lines, preserve exact wording in motion_prompt — do not paraphrase. Production, timing, and camera directions are action beats: execute visually; never treat them as dialogue to speak.
- On-screen branding only when the brief or logo attachments require it — then match those files. Do not invent logos or watermarks.
- Every shot MUST include media_desc (one sentence), image_prompt, motion_prompt, and transition that advance THAT story in order.
- transition (REQUIRED on every shot):
  - Shot 0: always "cut".
  - "continue": same continuous action / match-on-action from the previous panel — same place in the room, same character blocking continuity; the opening still should be the previous clip's last frame.
  - "cut": new framing, location, character focus, montage jump, or insert — a fresh opening still is required.
- motion_prompt is everything that happens DURING the clip after that still: camera, performance, and sound as the brief requires (diegetic sync by default; score only if the brief/attachments call for it).
- Panel N+1 with transition "continue" must describe action that can start from panel N's ending frame. Panel N+1 with transition "cut" may change camera/subject as the story needs while keeping named cast identity when they reappear.
- Content safety: no gore, pornography, politically sensitive content, religious extremism, privacy violations. Cartoon slapstick asked by the operator (funny faces, comedic mishaps, a piano falling as a gag) is allowed — keep it non-gory and fantastical.
- motion_prompt is sent to a safety-filtered video model. Prefer camera, performance, and diegetic sound. Do not write realistic fight choreography, blood, or weapon impact. Comedic non-injury slapstick from the operator prompt is fine.
- Uniqueness sidecar = occupied premises already used in this field. Do not copy or paraphrase those lines. If the operator prompt already differs, follow the operator prompt. Only tweak surface details when a uniqueness rewrite is required — never abandon the operator's plot.${
    auto ? autoRequirementsPrompt(autoOptionsFromRun(run)) : ""
  }`;

  // The corner logo is composited at stitch; any "logo bug" the writer describes would be drawn twice.
  const dropLogoBug = (text: string) =>
    hasLogoFile ? text.replace(/[^.!?]*\blogo bug\b[^.!?]*[.!?]?/gi, "").replace(/\s{2,}/g, " ").trim() : text;
  // Callouts are overlaid at stitch; a sentence quoting one would have the model draw it as well.
  const dropCallout = (text: string, callout?: string | null) => {
    const c = callout?.trim();
    if (!c) return text;
    const quoted = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .replace(new RegExp(`[^.!?]*['"‘’“”]${quoted}['"‘’“”][^.!?]*[.!?]?`, "gi"), "")
      .replace(/\s{2,}/g, " ")
      .trim();
  };
  const normalize = (parsed: ScriptPlan): ScriptPlan => {
    // Argon owns shot count — we only snap each duration onto the generator's allowed set.
    parsed.shots = parsed.shots.map((s, i) => ({
      ...s,
      image_prompt: dropCallout(dropLogoBug(s.image_prompt), s.callout),
      motion_prompt: dropCallout(dropLogoBug(s.motion_prompt), s.callout),
      index: i,
      duration: snapShotDuration(Number(s.duration) || allowed[0]!, allowed),
      media_desc: s.media_desc?.trim() || s.image_prompt.slice(0, 220),
      transition: (i === 0 ? "cut" : s.transition === "continue" ? "continue" : "cut") as ShotTransition,
    }));
    if (auto) {
      if (parsed.delivery_fps == null) {
        const fromBrief = deliveryFpsFromPrompt(run.initial_prompt);
        const n = Number(fromBrief.includes("/") ? 30 : fromBrief);
        parsed.delivery_fps = Number.isFinite(n) ? n : 30;
      }
      if (!parsed.delivery_resolution) {
        parsed.delivery_resolution = runOutputResolution(run);
      }
    }
    return parsed;
  };

  const ask = async (extra: string) => {
    const attachments = formatInputsForScript(run.input_assets_json);
    const user = `Initial prompt (MANDATORY — storyboard this, do not replace):\n${run.initial_prompt}\n\n${attachments ? `${attachments}\n\n` : ""}Occupied premises in this field (do not copy; still obey the initial prompt):\n${formatAntiPromptSidecar(sidecar)}\n\n${run.revise_comment ? `Reviser notes: ${run.revise_comment}\n\n` : ""}${extra}`;
    const content = await brainCompletion({
      model: BRAIN_MODEL,
      json: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return normalize(scriptPlanSchema.parse(parseJsonObject(content)));
  };

  let parsed = await ask("");
  const collision = storyboardTooClose(run.category, parsed);
  if (collision) {
    await updateRun(run.id, { error: "Rewriting storyboard — too close to an occupied premise…" });
    parsed = await ask(
      `Your last draft overlaps an occupied premise (${collision.score.toFixed(2)}): "${collision.media_desc}". Keep the operator's initial prompt beats (cast, setting, ending). Only change wording/details that collide with that occupied premise — do not invent a new story.`,
    );
  }

  await updateRun(run.id, {
    script_json: JSON.stringify(parsed),
    status: "waiting_human",
    gate: "script",
    error: auto ? "Auto: storyboard ready…" : null,
  });
}

async function jobScriptDirect(run: RunRow): Promise<void> {
  await updateRun(run.id, { status: "generating", gate: null, error: "Segmenting operator script…" });
  const videoInfo = await inspectVideoModel(run.video_model);
  if (videoInfo.supports1080p === false) {
    throw new Error(`Video model ${run.video_model} cannot emit 1080p and is not eligible.`);
  }
  const durations = planShotDurations(videoInfo.durations, run.target_duration);
  const parsed = await buildDirectScriptPlan({ run, durations, reviseComment: run.revise_comment });
  await updateRun(run.id, {
    script_json: JSON.stringify(parsed),
    status: "waiting_human",
    gate: "script",
    error: null,
  });
}

function applyDirection(base: string, note: string | null | undefined): string {
  const n = note?.trim();
  if (!n) return base;
  return [
    `HARD REQUIREMENT - follow this exactly (overrides any conflicting instruction below): ${n}`,
    `If the storyboard or motion notes fight this requirement, obey the requirement and keep everything else.`,
    ``,
    base.trim(),
  ].join("\n");
}

function continuationLock(script: ScriptPlan): string {
  // Subjects often include brands/roles/places — only lock real people names.
  const people = script.subjects.filter((s) => {
    const t = s.trim();
    if (!t) return false;
    if (
      /\b(session|structure|graphic|office|room|step|process|framework|list|logistics|equipment|ppe|protective|safety|warehouse|brand|company|training)\b/i.test(
        t,
      )
    ) {
      return false;
    }
    // Person-like: "Marcus Reed" or a single capitalized given name — not multi-word orgs.
    return /^[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+)+$/.test(t) || /^[A-Z][a-z]{2,}$/.test(t);
  });
  const cast = people.join("; ");
  const who = cast
    ? `Cast lock (people only): ${cast}. If they appear in the first-frame still, keep their identity — do not recast.`
    : `Keep the person already visible in the first-frame still. Do not recast.`;
  return `\n\nThe first frame image is the approved storyboard keyframe. Hold that opening pose, face, wardrobe, and camera. ${who} Then play the motion. Prefer natural talking-head performance. Do not add title cards, bullet lists, or on-screen text unless the motion prompt explicitly asks for them. Sound follows the brief.`;
}

/** Extract previous clip's last frame for the hard-join keyframe option (#0). */
async function previousClipJoinFrame(run: RunRow, shotIndex: number): Promise<string> {
  const prevClip = (await listVariants(run.id, shotIndex - 1, "clip")).find((v) => v.selected);
  if (!prevClip) throw new Error("Previous shot has no selected clip");
  if (!fs.existsSync(prevClip.path)) throw new Error("Previous clip file is missing on disk");

  const shotDir = path.join(runDir(run.id), `shot_${shotIndex}`);
  fs.mkdirSync(shotDir, { recursive: true });
  const dim = imageDimensionsForAspect(run.aspect_ratio as VideoAspect, runOutputResolution(run));
  const joinPath = path.join(shotDir, "ref_prev_tail.png");
  await extractLastFrameKeyframe(prevClip.path, joinPath, dim.width, dim.height);
  return joinPath;
}

/** Plain description of a hex colour ("dark green", "light grey") for image prompts. */
function describeHex(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const tone = l < 0.18 ? "very dark" : l < 0.35 ? "dark" : l > 0.85 ? "very light" : l > 0.65 ? "light" : "mid";
  if (s < 0.15 || d < 0.06) {
    if (l > 0.97) return "white";
    if (l < 0.1) return "black";
    return l < 0.3 ? "charcoal" : `${tone} grey`;
  }
  let h = 0;
  if (max === r) h = ((g! - b!) / d) % 6;
  else if (max === g) h = (b! - r!) / d + 2;
  else h = (r! - g!) / d + 4;
  h = (h * 60 + 360) % 360;
  const hue =
    h < 15 || h >= 345 ? "red" : h < 40 ? "orange" : h < 65 ? "yellow" : h < 160 ? "green" : h < 200 ? "teal" : h < 255 ? "blue" : h < 290 ? "purple" : "pink";
  return `${tone} ${hue}`;
}

/**
 * Image models draw hex codes and quoted brand colour names ("Haven Green") as literal text.
 * Replace `'Brand Name' (#RRGGBB)` / `Brand Name (#RRGGBB)` / bare `#RRGGBB` with a plain colour.
 */
function plainColourNames(prompt: string): string {
  return prompt
    .replace(
      /(['"‘’“”]?)((?:[A-Z][\w-]*\s){0,2}[A-Z][\w-]*)['"‘’“”]?\s*\(?\s*(#[0-9a-fA-F]{6})\b\s*\)?/g,
      (_m, _q, _name, hex: string) => ` ${describeHex(hex)} `,
    )
    .replace(/\(?\s*#[0-9a-fA-F]{6}\b\s*\)?/g, (m) => ` (${describeHex(m.replace(/[()\s]/g, ""))}) `)
    // Brand colour names ("Westhaven Forest green") get rendered as text: keep only the plain colour words.
    .replace(
      /\b((?:[A-Z][\w-]*\s){1,3})(green|blue|red|black|white|grey|gray|navy|gold|silver|orange|yellow|purple|teal|charcoal|cream|beige|brown|pink)\b/g,
      (_m, lead: string, colour: string) => {
        const keep = lead
          .trim()
          .split(/\s+/)
          .map((w) => w.toLowerCase())
          .filter((w) => /^(forest|navy|sky|royal|deep|dark|light|pale|slate|olive|sage|mint|lime|bright|warm|cool|off|soft|midnight|emerald|bottle|racing|steel|stone|sand)$/.test(w));
        return [...keep, colour.toLowerCase()].join(" ");
      },
    )
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function buildOpenKeyframePrompt(
  run: RunRow,
  script: ScriptPlan,
  shot: ScriptPlan["shots"][number],
  opts?: { allowNewScene?: boolean },
): Promise<{ prompt: string; referencePaths?: string[] }> {
  const hasFootageRefs = parseRunInputs(run.input_assets_json).some(
    (a) => a.kind === "video" && classifyOperatorVideoRole(a.filename) === "reference",
  );
  const frameRules = [
    "Output ONE continuous cinematic still — a single camera frame.",
    "Do not make a collage, grid, moodboard, contact sheet, split-screen, or multi-panel layout.",
    "Do not tile multiple scenes, portraits, or title cards into one image.",
  ].join(" ");
  const imagePrompt = plainColourNames(shot.image_prompt);
  // People's names come from the presenter headshot filenames (e.g. "Andy_Walker_HEADSHOT.jpg").
  const presenterNames = parseRunInputs(run.input_assets_json)
    .filter((a) => a.kind === "image" && isLikelyPresenterStill(a.filename))
    .flatMap((a) =>
      filenameWords(a.filename)
        .replace(/\.[a-z0-9]+$/, "")
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2 && !/^(headshot|head|shot|portrait|presenter|talent|speaker|host|photo|image|ref|reference)$/.test(w)),
    );
  const namesSubject = presenterNames.some((n) => new RegExp(`\\b${n}\\b`, "i").test(imagePrompt));
  const graphicCard =
    (/\b(logo|title card|wordmark|end card|end frame|closing card|opening card)\b/i.test(imagePrompt) ||
      isGraphicCardPrompt(imagePrompt)) &&
    !namesSubject &&
    !/\b(presenter|person|man|woman|employee|staff|hand|people)\b/i.test(imagePrompt);
  const lines = [imagePrompt, "", frameRules];
  if (opts?.allowNewScene) {
    lines.push(
      "NEW SHOT / CUT: Follow THIS image prompt for setting, framing, and action.",
      "Do not keep the previous shot's location, props, or camera unless this prompt asks for them.",
      "Soft continuity only: overall look/grade, and named-subject identity when those people appear.",
    );
  }
  if (script.subjects.length && !graphicCard) {
    lines.push(
      `Named subjects for this session: ${script.subjects.join("; ")}.`,
      "Only show people who belong in THIS still (per the image description). Do not force the full cast into a landscape-only or detail-only panel.",
      "When a named person appears, keep a consistent face, age, and wardrobe for that role across panels — do not recast.",
    );
    if (hasFootageRefs) {
      lines.push(
        "Identity lock: use the attached reference footage as the source of truth for those people. Match the real faces from those plates; do not invent different ages or strangers.",
      );
    }
  }
  let prompt = applyDirection(lines.join("\n"), run.revise_comment);
  const autoOpts = isAutoRun(run) ? autoOptionsFromRun(run) : null;
  const visual = await operatorVisualRefs(run, {
    maxVideoStills: hasFootageRefs ? 8 : 4,
    preferPresenter: Boolean(autoOpts?.presenterIdentity),
  });
  // Graphic cards get no presenter/location refs, or the model composites the host into the card.
  const opRefs = graphicCard ? [] : visual.imagePaths.slice(0, hasFootageRefs ? 6 : 4);
  if (graphicCard) {
    prompt = `${prompt}\nGRAPHIC CARD: flat designed title frame only — no people, no room, no furniture, no photographic set.`;
  }
  if (opRefs.length || parseRunInputs(run.input_assets_json).some((a) => a.kind === "image" || a.kind === "video")) {
    // People rules on a card make the image model paint a person into it.
    const suffix = graphicCard
      ? operatorRefsPromptSuffix(run)
          .split("\n")
          .filter((l) => !/^- (PRESENTER|VOICE|VERBATIM|PACING)\b/.test(l))
          .join("\n")
      : operatorRefsPromptSuffix(run);
    prompt = applyDirection(`${prompt}${suffix}`, run.revise_comment);
  } else if (autoOpts) {
    const extra = autoRequirementsPrompt(autoOpts).trim();
    if (extra) prompt = applyDirection(`${prompt}\n${extra}`, run.revise_comment);
  }
  return { prompt, referencePaths: opRefs.length ? opRefs : undefined };
}

function isAutoRun(run: RunRow): boolean {
  return run.pipeline_mode === "auto";
}

function resolveShotTransition(shot: ScriptPlan["shots"][number] | undefined, shotIndex: number): ShotTransition {
  if (shotIndex <= 0) return "cut";
  return shot?.transition === "continue" ? "continue" : "cut";
}

function variantPasses(v: { probe_json: string | null }): boolean {
  try {
    const report = JSON.parse(v.probe_json || "{}").report as { pass?: boolean } | undefined;
    return report?.pass !== false;
  } catch {
    return true;
  }
}

const AUTO_CHECKLIST: Checklist = { purity: true, safety: true, structure: true, identity: true };

async function patchScriptShot(
  runId: string,
  shotIndex: number,
  patch: Partial<ScriptPlan["shots"][number]>,
): Promise<ScriptPlan> {
  const run = await getRun(runId);
  if (!run?.script_json) throw new Error("Script missing");
  const script = scriptPlanSchema.parse(JSON.parse(run.script_json));
  const shot = script.shots[shotIndex];
  if (!shot) throw new Error(`No shot ${shotIndex}`);
  const cleaned = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<ScriptPlan["shots"][number]>;
  script.shots[shotIndex] = {
    ...shot,
    ...cleaned,
    index: shotIndex,
    duration: cleaned.duration ?? shot.duration,
  };
  await updateRun(runId, { script_json: JSON.stringify(script) });
  return script;
}

/**
 * Hands-off mode: advance past HITL gates using cut/continue keyframe rules.
 * Exported so the worker can unstick auto cooks left in waiting_human (e.g. after restart).
 */
export async function advanceAutoRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run || !isAutoRun(run)) return;
  if (run.status !== "waiting_human" || !run.gate) return;

  if (run.gate === "script") {
    await updateRun(run.id, { error: "Auto: storyboard locked — generating keyframes…" });
    approveScript(run.id);
    return;
  }

  if (run.gate === "keyframe") {
    const script = parseScript(run);
    const shotIndex = run.current_shot_index;
    const transition = resolveShotTransition(script.shots[shotIndex], shotIndex);
    const kfRows = await listVariants(run.id, shotIndex, "keyframe");
    for (const v of kfRows) {
      try {
        await ensureAbsRunFile(v.path);
      } catch {
        /* missing in bucket */
      }
    }
    const pool = kfRows.filter(
      (v) => !v.rejected && fs.existsSync(v.path) && variantPasses(v),
    );
    if (!pool.length) throw new Error(`Scene ${shotIndex + 1}: no usable keyframes`);
    const join = pool.find((v) => v.model_name === "join:prev_clip_tail");
    const generated = pool.filter((v) => v.model_name !== "join:prev_clip_tail");
    let pick = transition === "continue" ? join ?? generated[0] : generated[0] ?? join;
    if (!pick) throw new Error(`Scene ${shotIndex + 1}: could not pick a keyframe (${transition})`);
    const total = script.shots.length;

    await updateRun(run.id, {
      error: `Scene ${shotIndex + 1}/${total}: ${
        pick.model_name === "join:prev_clip_tail" ? "hard join (continue)" : "generated still (cut)"
      }…`,
    });
    selectKeyframe(run.id, pick.id);
    return;
  }

  if (run.gate === "clip") {
    const shotIndex = run.current_shot_index;
    const script = parseScript(run);
    const clipRows = await listVariants(run.id, shotIndex, "clip");
    for (const v of clipRows) {
      try {
        await ensureAbsRunFile(v.path);
      } catch {
        /* missing in bucket */
      }
    }
    const pool = clipRows.filter(
      (v) => !v.rejected && fs.existsSync(v.path) && variantPasses(v),
    );
    if (!pool.length) throw new Error(`Scene ${shotIndex + 1}: no usable clips`);
    const pick = pool.sort((a, b) => a.variant_index - b.variant_index)[0]!;

    await updateRun(run.id, {
      error: `Scene ${shotIndex + 1}/${script.shots.length} — keeping clip take #${pick.variant_index}…`,
    });
    selectClip(run.id, pick.id, { aesthetic: 7, consistency: 80 }, AUTO_CHECKLIST, false);
    return;
  }

  if (run.gate === "audit") {
    await updateRun(run.id, { error: "Auto: stitch approved — exporting…" });
    approveFinal(run.id, AUTO_CHECKLIST, false);
  }
}

/** Advance any auto run stuck at a HITL gate with no pending/running job. */
export async function advanceStuckAutoRuns(): Promise<number> {
  let advanced = 0;
  for (const run of await listWaitingRuns()) {
    if (run.pipeline_mode !== "auto" || !run.gate) continue;
    if (await runHasBusyJobs(run.id)) continue;
    try {
      await advanceAutoRun(run.id);
      advanced += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateRun(run.id, { status: "failed", error: `Auto advance: ${message}` });
    }
  }
  return advanced;
}

async function jobKeyframes(run: RunRow, shotIndex: number): Promise<void> {
  await updateRun(run.id, { status: "generating", gate: null, current_shot_index: shotIndex, error: null });
  const script = parseScript(run);
  const shot = script.shots[shotIndex];
  if (!shot) throw new Error(`No shot ${shotIndex}`);
  const cfg = loadModelsConfig();
  const auto = isAutoRun(run);
  const transition = resolveShotTransition(shot, shotIndex);
  // Auto: one AI still per cut (pipeline picks it). HITL keeps configured variant count.
  const n = auto ? 1 : Math.max(1, cfg.variantCount || VARIANT_COUNT_DEFAULT);
  const dir = path.join(runDir(run.id), `shot_${shotIndex}`, "keyframes");
  fs.mkdirSync(dir, { recursive: true });
  await rejectBatch(run.id, shotIndex, "keyframe");

  let variantIndex = 0;
  const wantJoin = shotIndex > 0 && (!auto || transition === "continue");
  const wantAi = shotIndex === 0 || !auto || transition === "cut";

  if (wantJoin) {
    const joinPath = await previousClipJoinFrame(run, shotIndex);
    const joinId = crypto.randomUUID();
    const joinOut = path.join(dir, `${joinId}.png`);
    fs.copyFileSync(joinPath, joinOut);
    const joinProbe = await probeFile(joinOut);
    const joinReport = evaluateImage(joinProbe, run.aspect_ratio, runOutputResolution(run));
    await insertVariant({
      id: joinId,
      run_id: run.id,
      shot_index: shotIndex,
      kind: "keyframe",
      variant_index: variantIndex++,
      path: joinOut,
      prompt: "Exact last frame of the previous approved clip (hard join). Prefer this for cut permanence.",
      model_name: "join:prev_clip_tail",
      selected: 0,
      rejected: 0,
      probe_json: JSON.stringify({ probe: joinProbe, report: joinReport }),
      uniq_id: null,
    });
  }

  // Product Omni path: no Seedream — cut scenes use a T2V marker; continue uses join frame only.
  const omniProduct = auto && isOmniModel(run.video_model);
  if (wantAi && omniProduct) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const dim = imageDimensionsForAspect(
      omniNativeAspect(run.aspect_ratio as VideoAspect) as VideoAspect,
      runOutputResolution(run),
    );
    const variantId = crypto.randomUUID();
    const out = path.join(dir, `${variantId}.png`);
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${dim.width}x${dim.height}:d=0.04`,
        "-frames:v",
        "1",
        out,
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const probe = await probeFile(out);
    const report = evaluateImage(probe, run.aspect_ratio, runOutputResolution(run));
    await insertVariant({
      id: variantId,
      run_id: run.id,
      shot_index: shotIndex,
      kind: "keyframe",
      variant_index: variantIndex++,
      path: out,
      prompt: shot.motion_prompt,
      model_name: "omni:text_to_video",
      selected: 0,
      rejected: 0,
      probe_json: JSON.stringify({ probe, report }),
      uniq_id: null,
    });
  } else if (wantAi) {
    const aiCount = shotIndex > 0 && wantJoin ? Math.max(0, n - 1) : n;
    const open = await buildOpenKeyframePrompt(run, script, shot, {
      allowNewScene: shotIndex > 0,
    });
    for (let i = 0; i < aiCount; i++) {
      const variantId = crypto.randomUUID();
      const out = path.join(dir, `${variantId}.png`);
      const takeLabel = variantIndex + 1;
      await updateRun(run.id, {
        error: `Scene ${shotIndex + 1}/${script.shots.length} take ${takeLabel}: ${
          shotIndex > 0 ? "following image prompt (new scene allowed)…" : "generating still…"
        }`,
      });
      await generateImage({
        model: run.keyframe_model,
        prompt: open.prompt,
        aspectRatio: run.aspect_ratio,
        outPath: out,
        referencePaths: open.referencePaths,
        outputResolution: runOutputResolution(run),
      });
      const probe = await probeFile(out);
      const report = evaluateImage(probe, run.aspect_ratio, runOutputResolution(run));
      await insertVariant({
        id: variantId,
        run_id: run.id,
        shot_index: shotIndex,
        kind: "keyframe",
        variant_index: variantIndex++,
        path: out,
        prompt: open.prompt,
        model_name: run.keyframe_model,
        selected: 0,
        rejected: 0,
        probe_json: JSON.stringify({ probe, report }),
        uniq_id: null,
      });
    }
  }

  if (variantIndex === 0) throw new Error(`No keyframes produced for shot ${shotIndex + 1}`);
  await updateRun(run.id, {
    status: "waiting_human",
    gate: "keyframe",
    error: auto
      ? omniProduct
        ? `Scene ${shotIndex + 1}/${script.shots.length} ready for Omni (${transition})…`
        : `Scene ${shotIndex + 1}/${script.shots.length} keyframes ready (${transition})…`
      : null,
  });
}

async function jobClips(run: RunRow, shotIndex: number): Promise<void> {
  await updateRun(run.id, { status: "generating", gate: null, current_shot_index: shotIndex, error: null });
  let script = parseScript(run);
  let shot = script.shots[shotIndex];
  if (!shot) throw new Error(`No shot ${shotIndex}`);
  const cfg = loadModelsConfig();
  const auto = isAutoRun(run);
  const n = auto ? 1 : cfg.variantCount || VARIANT_COUNT_DEFAULT;
  const info = await inspectVideoModel(run.video_model);
  const kf = (await listVariants(run.id, shotIndex, "keyframe")).find((v) => v.selected);
  if (!kf) throw new Error("Select a keyframe before generating clips");
  // Omni product cuts: T2V marker has no real first frame — omit for text_to_video.
  const omniT2v = isOmniModel(run.video_model) && kf.model_name === "omni:text_to_video";
  if (info.supportsI2v === false && !omniT2v) {
    throw new Error(
      `Video model ${run.video_model} does not support first-frame I2V. Cannot start a shot from a keyframe.`,
    );
  }
  const firstFrame = omniT2v ? undefined : kf.path;
  const genAspect = isOmniModel(run.video_model)
    ? omniNativeAspect(run.aspect_ratio)
    : run.aspect_ratio;
  const dir = path.join(runDir(run.id), `shot_${shotIndex}`, "clips");
  fs.mkdirSync(dir, { recursive: true });
  // Keep live takes from prior partial runs (overload mid-batch). Fresh sets are
  // rejected by the caller (new keyframe / Reject clips) before this job is enqueued.
  const keepers = (await listVariants(run.id, shotIndex, "clip")).filter(
    (v) => !v.rejected && fs.existsSync(v.path),
  );
  const need = Math.max(0, n - keepers.length);
  if (need === 0) {
    await updateRun(run.id, {
      status: "waiting_human",
      gate: "clip",
      error: isAutoRun(run) ? `Scene ${shotIndex + 1}/${script.shots.length} clip ready…` : null,
    });
    return;
  }
  if (keepers.length) {
    await updateRun(run.id, {
      error: `Scene ${shotIndex + 1}/${script.shots.length}: keeping ${keepers.length} saved take(s); generating ${need} more…`,
    });
  }
  const visual = await operatorVisualRefs(run, {
    preferPresenter: isAutoRun(run) && autoOptionsFromRun(run).presenterIdentity,
  });
  const filterErrors: string[] = [];
  let made = 0;
  let salvageMessage: string | null = null;
  const shotHadPriorFilter = Boolean(
    getDb()
      .prepare(
        `SELECT 1 AS ok FROM jobs WHERE run_id=? AND type='clips' AND payload_json LIKE ? AND coalesce(error,'') LIKE '%filtered%' LIMIT 1`,
      )
      .get(run.id, `%"shotIndex":${shotIndex}%`),
  );

  const musicBed = await runMusicBed(run);
  for (let i = 0; i < need; i++) {
    // The attached bed is mixed at stitch; per-clip generated music would fight it.
    let motionPrompt = musicBed
      ? shot.motion_prompt.replace(/[^.!?]*\b(music|score|soundtrack)\b[^.!?]*[.!?]?\s*/gi, "").trim() ||
        shot.motion_prompt
      : shot.motion_prompt;
    let produced = false;
    const maxSilentRewrites = auto && isOmniModel(run.video_model) ? 2 : 0;

    for (let rewritePass = 0; rewritePass <= maxSilentRewrites && !produced; rewritePass++) {
      if (rewritePass > 0) {
        await updateRun(run.id, {
          error: `Adjusting scene ${shotIndex + 1}/${script.shots.length} (rewrite ${rewritePass}/${maxSilentRewrites})…`,
        });
        try {
          const { rewriteSceneForFilter, applySceneRewrite } = await import("../autocook/rewriteScene");
          const rewritten = await rewriteSceneForFilter({
            plan: script,
            shotIndex,
            filterMessage: filterErrors[filterErrors.length - 1] ?? "content filtered",
            operatorBrief: run.initial_prompt,
          });
          script = applySceneRewrite(script, shotIndex, rewritten);
          await updateRun(run.id, { script_json: JSON.stringify(script) });
          shot = script.shots[shotIndex]!;
          motionPrompt = musicBed
            ? shot.motion_prompt.replace(/[^.!?]*\b(music|score|soundtrack)\b[^.!?]*[.!?]?\s*/gi, "").trim() ||
              shot.motion_prompt
            : shot.motion_prompt;
        } catch (rwErr) {
          console.warn(`[clips] silent rewrite failed`, rwErr);
        }
      }
      const variantId = crypto.randomUUID();
      const out = path.join(dir, `${variantId}.mp4`);
      const prompt = applyDirection(
        auto ? motionPrompt.trim() : `${motionPrompt}${continuationLock(script)}${operatorRefsPromptSuffix(run, shot)}`,
        run.revise_comment,
      );
      const takeLabel = keepers.length + made + 1;
      const recoveryRes =
        auto && (rewritePass > 0 || filterErrors.length > 0 || shotHadPriorFilter)
          ? ("1080p" as const)
          : runOutputResolution(run);
      try {
        await generateVideo({
          model: run.video_model,
          prompt,
          aspectRatio: genAspect,
          duration: snapDuration(shot.duration, info.durations) ?? shot.duration,
          firstFramePath: firstFrame,
          outPath: out,
          outputResolution: recoveryRes,
          // Auto Veo: no stills. Auto Omni: attach operator plates Argon planned against (no extra creative prompt).
          referenceImagePaths: auto
            ? isOmniModel(run.video_model)
              ? parseRunInputs(run.input_assets_json)
                  .filter((a) => a.kind === "image" && !isLikelyTrademarkAsset(a.filename) && fs.existsSync(a.path))
                  .map((a) => a.path)
                  .slice(0, 2)
              : undefined
            : visual.imagePaths.length
              ? visual.imagePaths
              : undefined,
          referenceVideoPaths:
            auto && !isOmniModel(run.video_model)
              ? undefined
              : visual.videoPaths.length
                ? mainPlateFirst(visual.videoPaths)
                : undefined,
          referenceVideoStartSec: plateInPointSec(run) + shotStartSec(script, shotIndex),
          referenceAudioPaths: auto ? undefined : visual.audioPaths.length ? visual.audioPaths : undefined,
          persistOnCapacity: auto,
          // Argon owns the take wording — do not platform-soften Omni prompts.
          maxFilterAttempts: auto && !isOmniModel(run.video_model) ? 2 : 1,
          educationalSoften: auto && !isOmniModel(run.video_model) && !run.category.startsWith("Short Drama"),
          brainOwnedPrompt: auto && isOmniModel(run.video_model),
          onStatus: async (msg) => await updateRun(run.id, {
              error: `Scene ${shotIndex + 1}/${script.shots.length} take ${takeLabel}/${n}: ${msg}`,
            }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isVideoFilterError(message)) {
          filterErrors.push(`variant ${takeLabel}: ${message}`);
          console.warn(`[clips] shot ${shotIndex} variant ${takeLabel} filtered (pass ${rewritePass})`);
          if (rewritePass < maxSilentRewrites) continue;
          break;
        }
        const live = keepers.length + made;
        if (live > 0 && (isVideoCapacityError(message) || /overloaded|try again later|high load/i.test(message))) {
          salvageMessage = message;
          console.warn(`[clips] shot ${shotIndex} salvaging ${live} take(s) after provider failure`);
          break;
        }
        if (live > 0) {
          salvageMessage = message;
          console.warn(`[clips] shot ${shotIndex} salvaging ${live} take(s) after error: ${message.slice(0, 200)}`);
          break;
        }
        throw err;
      }
      const probe = await probeFile(out);
      probe.crop = await detectBlackBars(out);
      const report = evaluateClip(probe, run.aspect_ratio, recoveryRes);
      await insertVariant({
        id: variantId,
        run_id: run.id,
        shot_index: shotIndex,
        kind: "clip",
        variant_index: keepers.length + made,
        path: out,
        prompt,
        model_name: recoveryRes === "1080p" && runOutputResolution(run) === "4K"
          ? `${run.video_model}|1080p-recovery`
          : run.video_model,
        selected: 0,
        rejected: 0,
        probe_json: JSON.stringify({ probe, report }),
        uniq_id: null,
      });
      made += 1;
      produced = true;
    }
    if (salvageMessage) break;
  }

  // Last proper takes: 1080p minimal on current KF, then (normal auto) continuity from a prior accepted clip.
  if (!made && auto && filterErrors.length && keepers.length === 0) {
    const wantDur = snapDuration(shot.duration, info.durations) ?? shot.duration ?? 8;
    const try1080 = async (framePath: string, prompt: string, label: string, modelTag: string) => {
      const variantId = crypto.randomUUID();
      const out = path.join(dir, `${variantId}.mp4`);
      await updateRun(run.id, {
        error: `Scene ${shotIndex + 1}/${script.shots.length}: ${label}…`,
      });
      await generateVideo({
        model: run.video_model,
        prompt,
        aspectRatio: run.aspect_ratio,
        duration: wantDur,
        firstFramePath: framePath,
        outPath: out,
        outputResolution: "1080p",
        preservePrompt: true,
        maxFilterAttempts: 1,
        persistOnCapacity: true,
        onStatus: async (msg) => await updateRun(run.id, {
            error: `Scene ${shotIndex + 1}/${script.shots.length} ${label}: ${msg}`,
          }),
      });
      const probe = await probeFile(out);
      probe.crop = await detectBlackBars(out);
      const report = evaluateClip(probe, run.aspect_ratio, "1080p");
      await insertVariant({
        id: variantId,
        run_id: run.id,
        shot_index: shotIndex,
        kind: "clip",
        variant_index: 0,
        path: out,
        prompt,
        model_name: `${run.video_model}|${modelTag}`,
        selected: 0,
        rejected: 0,
        probe_json: JSON.stringify({ probe, report }),
        uniq_id: null,
      });
      made = 1;
    };

    const cardShot = isGraphicCardPrompt(`${shot.image_prompt}\n${shot.motion_prompt}`);
    const dramaAuto = run.category.startsWith("Short Drama");
    try {
      const finalPrompt = cardShot
        ? minimalTalkingHeadPrompt(`${shot.image_prompt}\n${shot.motion_prompt}`)
        : dramaAuto
          ? [
              "Same framing and person as the first-frame still.",
              shot.motion_prompt
                .replace(/\b(victim|corpse|dead body|body covered|blood|gore|weapon\w*)\b/gi, "figure")
                .replace(/\b(No blood[^.]*\.|No gore[^.]*\.|No injury[^.]*\.)\s*/gi, "")
                .trim(),
              "Slow deliberate cinematic performance. Fictional film scene.",
            ].join(" ")
          : minimalTalkingHeadPrompt("");
      if (firstFrame) {
        await try1080(
          firstFrame,
          finalPrompt,
          cardShot
            ? "final 1080p Veo retake (card hold)"
            : dramaAuto
              ? "final 1080p Veo retake (drama-safe)"
              : "final 1080p Veo retake (filter-safe talking-head)",
          "1080p-retake",
        );
      }
    } catch (minErr) {
      console.warn(`[clips] shot ${shotIndex} final 1080p retake failed:`, minErr);
      filterErrors.push(
        `final-retake: ${minErr instanceof Error ? minErr.message : String(minErr)}`,
      );
    }

    // A card that Veo won't animate still has a correct picture: hold the still (voice-over is lost).
    if (!made && cardShot && firstFrame) {
      const variantId = crypto.randomUUID();
      const out = path.join(dir, `${variantId}.mp4`);
      try {
        await stillToClip(firstFrame, out, snapDuration(shot.duration, info.durations) ?? shot.duration);
        const probe = await probeFile(out);
        await insertVariant({
          id: variantId,
          run_id: run.id,
          shot_index: shotIndex,
          kind: "clip",
          variant_index: 0,
          path: out,
          prompt: "Static hold of the card still (video model would not animate it).",
          model_name: "ffmpeg:still_hold",
          selected: 0,
          rejected: 0,
          probe_json: JSON.stringify({ probe, report: evaluateClip(probe, run.aspect_ratio, "1080p") }),
          uniq_id: null,
        });
        made = 1;
      } catch (holdErr) {
        filterErrors.push(`still-hold: ${holdErr instanceof Error ? holdErr.message : String(holdErr)}`);
      }
    }

    // Normal auto: if this KF keeps empty-filtering, reuse a frame from an earlier clip Veo already accepted.
    // Skip prior clips whose prompts depict bodies/gore — those frames re-trip the filter.
    if (!made && !cardShot) {
      const riskyPrior = /\b(body|victim|corpse|deceased|blood|gore|sheet lift|covered body|dead)\b/i;
      let priorClip: Awaited<ReturnType<typeof listVariants>>[number] | undefined;
      for (const i of [...Array.from({ length: shotIndex }, (_, j) => j)].reverse()) {
        const hit = (await listVariants(run.id, i, "clip")).find(
          (v) => v.selected && !v.rejected && fs.existsSync(v.path),
        );
        if (hit && !riskyPrior.test(hit.prompt || "")) {
          priorClip = hit;
          break;
        }
      }
      if (priorClip) {
        const contId = crypto.randomUUID();
        const contFrame = path.join(runDir(run.id), `shot_${shotIndex}`, "keyframes", `${contId}.png`);
        try {
          await extractFirstFrame(priorClip.path, contFrame);
          await rejectBatch(run.id, shotIndex, "keyframe");
          await insertVariant({
            id: contId,
            run_id: run.id,
            shot_index: shotIndex,
            kind: "keyframe",
            variant_index: 0,
            path: contFrame,
            prompt: "Continuity still from earlier accepted presenter clip (filter recovery).",
            model_name: "join:prior_clip_frame",
            selected: 1,
            rejected: 0,
            probe_json: null,
            uniq_id: null,
          });
          await selectVariant(contId);
          const provenMotion = dramaAuto
            ? "Same person and wardrobe as the first-frame still. Slow deliberate motion — eyes scan a document, subtle expression shift, soft push-in. Paper rustle. Fictional film scene. No dialogue."
            : "Same person and framing as the first-frame still. Speaks clearly to camera in a calm instructional tone. Small natural hand gesture only. Single continuous talking-head take. Static camera. No cuts, no title cards, no lower thirds, no logos, no on-screen text, no UI.";
          await try1080(contFrame, provenMotion, "1080p continuity retake from earlier accepted clip", "1080p-continuity");
        } catch (contErr) {
          console.warn(`[clips] shot ${shotIndex} continuity retake failed:`, contErr);
          filterErrors.push(
            `continuity-retake: ${contErr instanceof Error ? contErr.message : String(contErr)}`,
          );
        }
      }
    }

  }

  const total = keepers.length + made;
  if (!total) {
    throw new Error(
      auto
        ? `Scene ${shotIndex + 1} clip empty/filtered after retries. Earlier scenes kept. Resume continues at scene ${shotIndex + 1} only. ${filterErrors.slice(0, 3).join(" | ") || ""}`.trim()
        : `All ${n} clip variants were filtered by the video model. ${filterErrors[0] ?? ""} Retry this stage, pick a different keyframe, or soften the motion (no weapon impact).`.trim(),
    );
  }
  if (salvageMessage && total < n) {
    await updateRun(run.id, {
      status: "waiting_human",
      gate: "clip",
      error: isAutoRun(run)
        ? `Scene ${shotIndex + 1}/${script.shots.length}: saved ${total} clip take(s) after provider failure — continuing…`
        : `Saved ${total}/${n} clip take(s) after provider failure. Pick one, or Retry to generate more without losing these.`,
    });
    return;
  }
  await updateRun(run.id, {
    status: "waiting_human",
    gate: "clip",
    error: isAutoRun(run) ? `Scene ${shotIndex + 1}/${script.shots.length} clip ready…` : null,
  });
}

/** Fix selected take: same I2V context as normal clips + HARD REQUIREMENT line (via applyDirection). */
async function jobClipEdit(run: RunRow, shotIndex: number, sourceVariantId: string): Promise<void> {
  await updateRun(run.id, { status: "generating", gate: null, current_shot_index: shotIndex, error: null });
  const script = parseScript(run);
  const shot = script.shots[shotIndex];
  if (!shot) throw new Error(`No shot ${shotIndex}`);
  const source = await getVariant(sourceVariantId);
  if (!source || source.run_id !== run.id || source.kind !== "clip" || source.shot_index !== shotIndex) {
    throw new Error("Pick the take you want to keep as the base for this fix.");
  }
  const note = run.revise_comment?.trim() || "";
  if (!note) throw new Error("Write the one change to make on this take.");

  const cfg = loadModelsConfig();
  const n = cfg.variantCount || VARIANT_COUNT_DEFAULT;
  const videoModel = run.video_model;
  const info = await inspectVideoModel(videoModel);
  const kf = (await listVariants(run.id, shotIndex, "keyframe")).find((v) => v.selected);
  if (!kf) throw new Error("Select a keyframe before fixing clips");
  if (info.supportsI2v === false) {
    throw new Error(
      `Video model ${videoModel} does not support first-frame I2V. Cannot regenerate this shot from the keyframe.`,
    );
  }

  const dir = path.join(runDir(run.id), `shot_${shotIndex}`, "clips");
  fs.mkdirSync(dir, { recursive: true });
  // Keep the picked take in the set; regenerate siblings from the same keyframe + hard direction.
  await rejectBatch(run.id, shotIndex, "clip", source.id);

  const basePrompt = `${shot.motion_prompt}${continuationLock(script)}${operatorRefsPromptSuffix(run, shot)}`;
  const prompt = applyDirection(basePrompt, note);
  const filterErrors: string[] = [];
  let made = 0;
  const visual = await operatorVisualRefs(run);
  for (let i = 0; i < n; i++) {
    const variantId = crypto.randomUUID();
    const out = path.join(dir, `${variantId}.mp4`);
    try {
      await generateVideo({
        model: videoModel,
        prompt,
        aspectRatio: run.aspect_ratio,
        duration: snapDuration(shot.duration, info.durations) ?? shot.duration,
        firstFramePath: kf.path,
        outPath: out,
        outputResolution: runOutputResolution(run),
        referenceImagePaths: visual.imagePaths.length ? visual.imagePaths : undefined,
        referenceVideoPaths: visual.videoPaths.length ? visual.videoPaths : undefined,
        referenceVideoStartSec: plateInPointSec(run) + shotStartSec(script, shotIndex),
        referenceAudioPaths: visual.audioPaths.length ? visual.audioPaths : undefined,
        onStatus: async (msg) => await updateRun(run.id, { error: `Fix take ${i + 1}/${n} (${videoModel}): ${msg}` }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isVideoFilterError(message)) {
        filterErrors.push(`variant ${i}: ${message}`);
        console.warn(`[clips] fix regenerate failed: ${message}`);
        continue;
      }
      filterErrors.push(`variant ${i}: ${message}`);
      console.warn(`[clips] fix regenerate filtered: ${message}`);
      continue;
    }
    const probe = await probeFile(out);
    probe.crop = await detectBlackBars(out);
    const report = evaluateClip(probe, run.aspect_ratio, runOutputResolution(run));
    await insertVariant({
      id: variantId,
      run_id: run.id,
      shot_index: shotIndex,
      kind: "clip",
      variant_index: i,
      path: out,
      prompt,
      model_name: videoModel,
      selected: 0,
      rejected: 0,
      probe_json: JSON.stringify({ probe, report }),
      uniq_id: null,
    });
    made += 1;
  }
  if (!made) {
    await updateRun(run.id, {
      status: "waiting_human",
      gate: "clip",
      error: `Fix regenerate failed on ${videoModel}. ${filterErrors[0] ?? "Unknown error."} The original take is still available.`.trim(),
    });
    return;
  }
  await updateRun(run.id, { status: "waiting_human", gate: "clip", error: null });
}

async function jobStitch(run: RunRow): Promise<void> {
  await updateRun(run.id, { status: "stitching", gate: null, error: "Stitching clips…" });
  const script = parseScript(run);
  const clips: string[] = [];
  const assets = parseRunInputs(run.input_assets_json);
  for (let i = 0; i < script.shots.length; i++) {
    const v = (await listVariants(run.id, i, "clip")).find((x) => x.selected);
    if (!v) throw new Error(`Shot ${i} has no selected clip`);
    const insert = script.shots[i]?.insert;
    const source = insert
      ? assets.find((a) => a.kind === "video" && a.filename.toLowerCase() === insert.source.trim().toLowerCase())
      : undefined;
    if (insert && source) {
      await updateRun(run.id, { error: `Cutting supplied footage into scene ${i + 1}…` });
      const composed = path.join(runDir(run.id), `shot_${i}`, "insert.mp4");
      await buildInsertClip({ source: source.path, start: insert.start, end: insert.end, audioClip: v.path, output: composed });
      clips.push(composed);
    } else {
      if (insert) console.warn(`[stitch] scene ${i + 1} insert source not attached: ${insert.source}`);
      // Argon owns shot duration — do not shorten graphic cards in post.
      clips.push(v.path);
    }
  }
  const out = path.join(runDir(run.id), "final.mp4");
  const musicBed = await runMusicBed(run);
  const stitched = musicBed ? path.join(runDir(run.id), "final_dialogue.mp4") : out;
  const bookends = operatorBookendVideos(run.input_assets_json);
  if (bookends.intros.length || bookends.outros.length) {
    await updateRun(run.id, {
      error: `Stitching clips with ${bookends.intros.length} intro + ${bookends.outros.length} outro operator plate(s)…`,
    });
  }
  const finishRes =
    script.delivery_resolution === "4K" || script.delivery_resolution === "1080p"
      ? script.delivery_resolution
      : runOutputResolution(run);
  await stitchSession(
    clips,
    stitched,
    run.aspect_ratio as VideoAspect,
    finishRes,
    { head: bookends.intros, tail: bookends.outros },
    planDeliveryFps(run, script),
  );
  const needMusicWindows = Boolean(musicBed) && script.shots.some((s) => s.music === false);
  const needLogoBug = script.shots.some((s) => s.logo_bug === true);
  const needCallouts = script.shots.some((s) => s.callout?.trim());
  let shotSpans: Array<{ start: number; end: number }> = [];
  let editEnd = 0;
  if (needMusicWindows || needLogoBug || needCallouts) {
    let t = 0;
    for (const p of bookends.intros) t += (await probeFile(p)).duration ?? 0;
    for (let i = 0; i < clips.length; i++) {
      const d = (await probeFile(clips[i])).duration ?? script.shots[i]?.duration ?? 0;
      shotSpans.push({ start: t, end: t + d });
      t += d;
    }
    editEnd = t;
  }
  /** Merge consecutive selected shots into continuous timeline windows. */
  const windowsWhere = (keep: (i: number) => boolean) => {
    const windows: Array<{ start: number; end: number }> = [];
    shotSpans.forEach((span, i) => {
      if (!keep(i)) return;
      const last = windows[windows.length - 1];
      if (last && Math.abs(last.end - span.start) < 0.05) last.end = span.end;
      else windows.push({ ...span });
    });
    return windows;
  };

  let picture = stitched;
  if (needLogoBug || needCallouts) {
    const logos = needLogoBug ? assets.filter((a) => a.kind === "image" && isLikelyTrademarkAsset(a.filename)) : [];
    const tone = (re: RegExp) => logos.find((a) => re.test(filenameWords(a.filename)))?.path;
    const light = tone(/\b(white|light|reverse|reversed|knockout|negative)\b/) ?? logos[0]?.path;
    const dark = tone(/\b(black|dark|mono)\b/) ?? logos.find((l) => l.path !== light)?.path ?? logos[0]?.path;
    const callouts = script.shots.flatMap((s, i) => {
      const span = shotSpans[i];
      const text = s.callout?.trim();
      if (!span || !text) return [];
      const len = span.end - span.start;
      return [{ start: span.start + Math.min(1.2, len * 0.15), end: span.end - Math.min(0.8, len * 0.1), text }];
    });
    if (light || dark || callouts.length) {
      await updateRun(run.id, { error: "Placing logo bug and callouts…" });
      const withLogo = path.join(runDir(run.id), musicBed ? "final_dialogue_logo.mp4" : "final_logo.mp4");
      await overlayLogoBug({
        video: stitched,
        output: withLogo,
        windows: windowsWhere((i) => script.shots[i]?.logo_bug === true),
        light,
        dark,
        callouts,
        calloutColor: script.callout_color ?? undefined,
      });
      picture = withLogo;
    }
  }
  if (musicBed) {
    await updateRun(run.id, { error: `Mixing ${musicBed.filename} under dialogue…` });
    let musicWindows: Array<{ start: number; end: number }> | undefined;
    if (needMusicWindows) {
      musicWindows = windowsWhere((i) => script.shots[i]?.music !== false);
      const tail = musicWindows[musicWindows.length - 1];
      if (bookends.outros.length && tail && Math.abs(tail.end - editEnd) < 0.05) tail.end = Number.POSITIVE_INFINITY;
    }
    await mixMusicBed({ video: picture, music: musicBed.path, output: out, windows: musicWindows });
  } else if (picture !== out) {
    fs.renameSync(picture, out);
  }
  const master = deliveryMasterSpec(run);
  const masterPath = deliveryMasterPath(run);
  if (master && masterPath) {
    const src = await probeFile(out);
    const fps = planDeliveryFps(run, script);
    const [num, den] = fps.split("/").map(Number);
    const fpsValue = den ? num! / den : num!;
    let frames = master.frames;
    let width = master.size?.width ?? src.width ?? 1920;
    let height = master.size?.height ?? src.height ?? 1080;
    if (master.matchPlateDuration) {
      const plates = parseRunInputs(run.input_assets_json).filter((a) => a.kind === "video" && fs.existsSync(a.path));
      if (plates.length === 1) {
        const plate = await probeFile(plates[0]!.path);
        const plateFps = plate.fps && plate.fps > 0 ? plate.fps : fpsValue;
        frames = Math.max(1, Math.round((plate.duration ?? 0) * plateFps));
        width = plate.width || width;
        height = plate.height || height;
      }
    }
    frames = frames ?? Math.round((src.duration ?? 0) * fpsValue);
    await updateRun(run.id, { error: `Rendering delivery master (${master.codec}, ${frames} frames)…` });
    await conformExactDelivery({
      inPath: out,
      outPath: masterPath,
      width,
      height,
      fps,
      frames,
      codec: master.codec,
      keepAudio: !briefWantsNoAudio(run),
    });
  }
  const probe = await probeFile(out);
  probe.crop = await detectBlackBars(out);
  const report = evaluateStitch(probe, run.aspect_ratio, run.pipeline_mode, runOutputResolution(run));
  const reportPath = path.join(runDir(run.id), "stitch_report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ probe, report }, null, 2));
  for (const p of [out, reportPath, masterPath].filter(Boolean) as string[]) {
    try {
      await persistRunFile(p);
    } catch (err) {
      console.error(`[storage] persist stitch artifact failed`, p, err);
    }
  }
  await updateRun(run.id, {
    status: "waiting_human",
    gate: "audit",
    error: isAutoRun(run)
      ? report.pass
        ? "Auto: stitch ready — exporting…"
        : `Auto: stitch ready (soft §3.1 warns: ${report.checks
            .filter((c) => !c.pass)
            .map((c) => c.id)
            .join(",")}) — exporting…`
      : null,
  });
}

function parseScript(run: RunRow): ScriptPlan {
  if (!run.script_json) throw new Error("Script missing");
  return scriptPlanSchema.parse(JSON.parse(run.script_json));
}

function buildMeta(partial: MetaRecord): MetaRecord {
  return {
    ...partial,
    audio_path: partial.audio_path ?? null,
    origin_media_id: partial.origin_media_id ?? null,
    origin_media_path: partial.origin_media_path ?? null,
    mask_path: partial.mask_path ?? null,
    reference_images: partial.reference_images ?? [],
    ext_json: {
      source_platform: "Internal Pipeline",
      ...partial.ext_json,
    },
  };
}

function stillRefRel(sessionId: string, name: string): string {
  return `reference/input_images/${sessionId}_${name}`;
}

async function jobExport(run: RunRow): Promise<void> {
  const fresh = (await getRun(run.id))!;
  await updateRun(fresh.id, { error: "Exporting to dataset…" });
  const script = parseScript(fresh);
  const review = await getReview(fresh.id);
  const checklist = review?.checklist_json ? (JSON.parse(review.checklist_json) as Checklist) : null;
  if (!checklist || !checklistComplete(checklist)) {
    throw new Error("Human checklist must be all-pass before export");
  }
  const stitchPath = path.join(runDir(fresh.id), "final.mp4");
  await ensureAbsRunFile(stitchPath);
  const stitchProbe = await probeFile(stitchPath);
  stitchProbe.crop = await detectBlackBars(stitchPath);
  const stitchMode = fresh.pipeline_mode;
  const stitchReport = evaluateStitch(
    stitchProbe,
    fresh.aspect_ratio,
    stitchMode,
    runOutputResolution(fresh),
  );
  ensureDatasetLayout();

  const records: MetaRecord[] = [];
  const shotUniq: string[] = [];
  const kfRefRels: string[] = [];

  for (let i = 0; i < script.shots.length; i++) {
    let kf = (await listVariants(fresh.id, i, "keyframe")).find((v) => v.selected);
    // Shots can have a clip without a selected keyframe (e.g. supplied-footage inserts).
    if (!kf) {
      const clip = (await listVariants(fresh.id, i, "clip")).find((v) => v.selected && !v.rejected);
      if (!clip || !fs.existsSync(clip.path)) {
        throw new Error(`Missing selected keyframe for shot ${i}`);
      }
      const synthDir = path.join(runDir(fresh.id), `shot_${i}`, "keyframes");
      fs.mkdirSync(synthDir, { recursive: true });
      const synthId = crypto.randomUUID();
      const synthPath = path.join(synthDir, `${synthId}.png`);
      await extractFirstFrame(clip.path, synthPath);
      const synthProbe = await probeFile(synthPath);
      await insertVariant({
        id: synthId,
        run_id: fresh.id,
        shot_index: i,
        kind: "keyframe",
        variant_index: 0,
        path: synthPath,
        prompt: "export:first_frame_of_clip",
        model_name: "ffmpeg:export_still",
        selected: 0,
        rejected: 0,
        probe_json: JSON.stringify({ probe: synthProbe }),
        uniq_id: null,
      });
      await selectVariant(synthId);
      kf = (await listVariants(fresh.id, i, "keyframe")).find((v) => v.selected);
      if (!kf) throw new Error(`Missing selected keyframe for shot ${i}`);
    }
    let kfProbe = JSON.parse(kf.probe_json || "{}").probe as
      | { width: number; height: number }
      | undefined;
    if (!kfProbe?.width || !kfProbe?.height) {
      kfProbe = await probeFile(kf.path);
    }
    const kfRel = copyIntoDataset(kf.path, `image/agent_generated/${fresh.session_id}_shot${i}_kf.png`);
    const kfRefRel = copyIntoDataset(kf.path, stillRefRel(fresh.session_id, `shot${i}_kf.png`));
    kfRefRels.push(kfRefRel);
    const refs: string[] = [];
    if (i === 0) {
      for (const asset of parseRunInputs(fresh.input_assets_json).filter((a) => a.kind === "image")) {
        refs.push(
          copyIntoDataset(asset.path, stillRefRel(fresh.session_id, `op_${path.basename(asset.filename)}`)),
        );
      }
    }
    if (i > 0) {
      const identity = kfRefRels[0];
      const prev = kfRefRels[i - 1];
      if (identity) refs.push(identity);
      if (i > 1 && prev && prev !== identity) refs.push(prev);
      const tail = path.join(runDir(fresh.id), `shot_${i - 1}`, "tail.png");
      if (fs.existsSync(tail)) {
        refs.push(copyIntoDataset(tail, stillRefRel(fresh.session_id, `shot${i - 1}_tail.png`)));
      }
    }
    const kfId = exportUniqId(fresh.session_id, `s${i}_kf`);
    const kfMeta = buildMeta({
      uniq_id: kfId,
      modality: "image",
      generation_type: "agent_image",
      media_id: path.basename(kfRel),
      media_desc: script.shots[i]?.media_desc ?? script.media_desc,
      media_path: kfRel,
      format: "png",
      width: kfProbe.width,
      height: kfProbe.height,
      duration: null,
      fps: null,
      resolution: null,
      prompt: script.shots[i]?.image_prompt ?? kf.prompt,
      model_name: kf.model_name,
      category: fresh.category,
      tags: script.tags,
      session_id: fresh.session_id,
      round_index: null,
      parent_uniq_id: null,
      audio_path: null,
      origin_media_id: null,
      origin_media_path: null,
      mask_path: null,
      reference_images: refs,
      ext_json: {
        code_type: null,
        aspect_ratio: fresh.aspect_ratio,
        content_safety: "pass",
        aesthetic_score: review?.aesthetic_score ?? null,
        consistency_score: null,
        visual_style: script.visual_style,
      },
    });
    records.push(kfMeta);
    await upsertAsset({
      uniq_id: kfId,
      run_id: fresh.id,
      shot_index: i,
      role: "keyframe",
      path: kfRel,
      parent_uniq_id: null,
      meta_json: JSON.stringify(kfMeta),
    });
  }

  for (let i = 0; i < script.shots.length; i++) {
    const clip = (await listVariants(fresh.id, i, "clip")).find((v) => v.selected);
    if (!clip) throw new Error(`Missing clip shot ${i}`);
    let probe = JSON.parse(clip.probe_json || "{}").probe as
      | {
          width: number;
          height: number;
          duration: number | null;
          fps: number | null;
          codec: string | null;
        }
      | undefined;
    if (!probe?.width || !probe?.height) {
      const live = await probeFile(clip.path);
      probe = {
        width: live.width,
        height: live.height,
        duration: live.duration,
        fps: live.fps,
        codec: live.codec,
      };
    }
    const rel = copyIntoDataset(clip.path, `video/agent_generated/${fresh.session_id}_shot${i}.mp4`);
    const audioTmp = path.join(runDir(fresh.id), `shot_${i}_audio.m4a`);
    const audioRel = (await extractAudio(clip.path, audioTmp))
      ? copyIntoDataset(audioTmp, `audio/generated/${fresh.session_id}_shot${i}.m4a`)
      : null;
    const uniq = exportUniqId(fresh.session_id, `s${i}`);
    const meta = buildMeta({
      uniq_id: uniq,
      modality: "video",
      generation_type: "agent_video",
      media_id: path.basename(rel),
      media_desc: script.shots[i].media_desc,
      media_path: rel,
      format: "mp4",
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      fps: probe.fps ? Math.round(probe.fps) : null,
      resolution: [probe.width, probe.height],
      prompt: script.shots[i].motion_prompt,
      model_name: clip.model_name,
      category: fresh.category,
      tags: script.tags,
      session_id: fresh.session_id,
      round_index: 0,
      parent_uniq_id: null,
      audio_path: audioRel,
      origin_media_id: null,
      origin_media_path: null,
      mask_path: null,
      reference_images: [kfRefRels[i]!],
      ext_json: {
        code_type: probe.codec === "hevc" || probe.codec === "h265" ? "H.265" : "H.264",
        aspect_ratio: fresh.aspect_ratio,
        content_safety: "pass",
        aesthetic_score: review?.aesthetic_score ?? null,
        consistency_score: review?.consistency_score ?? null,
        visual_style: script.visual_style,
      },
    });
    records.push(meta);
    shotUniq.push(uniq);
    await upsertAsset({
      uniq_id: uniq,
      run_id: fresh.id,
      shot_index: i,
      role: "clip",
      path: rel,
      parent_uniq_id: null,
      meta_json: JSON.stringify(meta),
    });
  }

  const firstShotRel = `video/agent_generated/${fresh.session_id}_shot0.mp4`;
  const finalRel = copyIntoDataset(stitchPath, `video/edited/${fresh.session_id}_final.mp4`);
  const masterPath = deliveryMasterPath(fresh);
  const finalMovPath =
    masterPath?.endsWith(".mov") && fs.existsSync(masterPath) ? masterPath : path.join(runDir(fresh.id), "final.mov");
  const finalMovRel = fs.existsSync(finalMovPath)
    ? copyIntoDataset(finalMovPath, `video/edited/${fresh.session_id}_final.mov`)
    : null;
  const deliveredProbe = finalMovRel ? await probeFile(finalMovPath) : stitchProbe;
  const finalId = exportUniqId(fresh.session_id, "final");
  const finalAudioTmp = path.join(runDir(fresh.id), "final_audio.m4a");
  const finalAudioRel = !briefWantsNoAudio(fresh) && (await extractAudio(stitchPath, finalAudioTmp))
    ? copyIntoDataset(finalAudioTmp, `audio/generated/${fresh.session_id}_final.m4a`)
    : null;
  const finalMeta = buildMeta({
    uniq_id: finalId,
    modality: "video",
    generation_type: "edit_video",
    media_id: path.basename(finalMovRel ?? finalRel),
    media_desc: script.media_desc,
    media_path: finalMovRel ?? finalRel,
    format: finalMovRel ? "mov" : "mp4",
    width: deliveredProbe.width,
    height: deliveredProbe.height,
    duration: deliveredProbe.duration,
    fps: deliveredProbe.fps ? Math.round(deliveredProbe.fps) : 30,
    resolution: [deliveredProbe.width, deliveredProbe.height],
    prompt: "Concatenate the approved storyboard clips into one continuous session cut.",
    model_name: "ffmpeg",
    category: fresh.category,
    tags: script.tags,
    session_id: fresh.session_id,
    round_index: 1,
    parent_uniq_id: shotUniq[0] ?? null,
    audio_path: finalAudioRel,
    origin_media_id: path.basename(firstShotRel),
    origin_media_path: firstShotRel,
    mask_path: null,
    reference_images: [],
    ext_json: {
      code_type: deliveredProbe.codec === "prores" ? "Apple ProRes 4444" : "H.264",
      aspect_ratio: fresh.aspect_ratio,
      content_safety: "pass",
      aesthetic_score: review?.aesthetic_score ?? null,
      consistency_score: review?.consistency_score ?? null,
      visual_style: script.visual_style,
      origin_instruction: "Session stitch of approved agent_video shots",
      human_instruction: "Approve stitched session",
      ...(typeof review?.consistency_score === "number" ? { score: review.consistency_score } : {}),
    },
  });
  records.push(finalMeta);

  const metaReports = records.map((r) => validateMetaRecord(r));
  const metaOk = { pass: metaReports.every((r) => r.pass), checks: metaReports.flatMap((r) => r.checks) };
  const gate = canExport({
    rejected: fresh.status === "rejected",
    stitch: stitchReport,
    checklistPass: checklistComplete(checklist),
    meta: metaOk,
    softStitchIds: isAutoRun(fresh) ? AUTO_SOFT_STITCH_IDS : undefined,
  });
  if (!gate.ok) {
    throw new Error(gate.reason);
  }
  const written = await withCatalogLock(() => {
    const result = appendMetaJsonl(records);
    if (!result.ok) return result;
    writeSessionDeliveryJson(fresh.session_id, records);
    if (fresh.pipeline_mode !== "direct") {
      appendAntiPrompt({
        session_id: fresh.session_id,
        uniq_id: finalId,
        category: fresh.category,
        media_desc: script.media_desc,
        prompt_digest: fresh.initial_prompt.slice(0, 280),
        tags: script.tags,
        subjects: script.subjects,
        setting: script.setting,
        visual_style: script.visual_style,
        duration: stitchProbe.duration ?? fresh.target_duration,
        aspect_ratio: fresh.aspect_ratio,
        shots: script.shots.map((s, i) => ({
          index: i,
          media_desc: s.media_desc?.trim() || s.image_prompt.slice(0, 220),
          still: s.image_prompt.trim(),
          motion: s.motion_prompt.trim(),
        })),
      });
    }
    return result;
  });
  if (!written.ok) throw new Error(written.errors.join("; "));
  writeDatasetInfo();
  await upsertAsset({
    uniq_id: finalId,
    run_id: fresh.id,
    shot_index: null,
    role: "stitch",
    path: finalRel,
    parent_uniq_id: shotUniq[0] ?? null,
    meta_json: JSON.stringify(finalMeta),
  });
  await updateRun(fresh.id, {
    status: "exported",
    counted: fresh.pipeline_mode === "agentic" ? 1 : 0,
    gate: null,
    error: null,
  });
}

export async function approveScript(runId: string): Promise<void> {
  const run = await requireWaiting(runId, "script");
  await enqueueJob(run.id, "keyframes", { shotIndex: 0 });
  await updateRun(run.id, { status: "generating", gate: null, current_shot_index: 0, revise_comment: null });
}

export async function reviseScript(runId: string, comment: string): Promise<void> {
  const run = await requireWaiting(runId, "script");
  await updateRun(run.id, { revise_comment: comment, status: "generating", gate: null });
  await enqueueJob(run.id, "script");
}

export async function selectKeyframe(runId: string, variantId: string): Promise<void> {
  const run = await requireWaiting(runId, "keyframe");
  const v = await getVariant(variantId);
  if (!v || v.run_id !== runId || v.kind !== "keyframe") throw new Error("Invalid keyframe variant");
  const report = JSON.parse(v.probe_json || "{}").report as { pass?: boolean } | undefined;
  if (report && report.pass === false) throw new Error("Cannot select a variant that failed §3.1 probes");
  await selectVariant(variantId);
  // New keyframe → wipe prior clips for this shot (retries after overload keep live takes instead).
  await rejectBatch(run.id, run.current_shot_index, "clip");
  await enqueueJob(run.id, "clips", { shotIndex: run.current_shot_index });
  await updateRun(run.id, { status: "generating", gate: null, revise_comment: null });
}

export async function rejectKeyframes(runId: string, comment: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown run");
  if (run.status !== "waiting_human" || (run.gate !== "keyframe" && run.gate !== "clip")) {
    throw new Error(`Run is not waiting on keyframe or clip (status=${run.status} gate=${run.gate})`);
  }
  const note = comment.trim();
  if (!note) throw new Error("Write a direction for the next generation before rejecting.");
  await rejectBatch(run.id, run.current_shot_index, "clip");
  await rejectBatch(run.id, run.current_shot_index, "keyframe");
  await updateRun(run.id, { revise_comment: note });
  bumpRework(run);
  await enqueueJob(run.id, "keyframes", { shotIndex: run.current_shot_index });
}

export async function selectClip(
  runId: string,
  variantId: string,
  scores: { aesthetic: number; consistency: number },
  checklist: Checklist,
  useXfade: boolean,
): Promise<void> {
  const run = await requireWaiting(runId, "clip");
  if (!checklistComplete(checklist)) throw new Error("Checklist must be all-pass");
  if (scores.aesthetic < 0 || scores.aesthetic > 10) throw new Error("Aesthetic 0–10 required");
  if (scores.consistency < 0 || scores.consistency > 100) throw new Error("Consistency 0–100 required");
  const v = await getVariant(variantId);
  if (!v || v.run_id !== runId || v.kind !== "clip") throw new Error("Invalid clip variant");
  const report = JSON.parse(v.probe_json || "{}").report as { pass?: boolean } | undefined;
  if (report && report.pass === false) throw new Error("Cannot select a variant that failed §3.1 probes");
  await selectVariant(variantId);
  await upsertReview({
    run_id: run.id,
    gate: "clip",
    checklist_json: JSON.stringify(checklist),
    aesthetic_score: scores.aesthetic,
    consistency_score: scores.consistency,
    use_xfade: useXfade ? 1 : 0,
  });
  const script = parseScript(run);
  const nextShot = run.current_shot_index + 1;
  if (nextShot < script.shots.length) {
    // Mid-session fix: if later shots already have approved clips, just restitch.
    if (await downstreamClipsSelected(run.id, script, nextShot)) {
      await enqueueJob(run.id, "stitch");
      await updateRun(run.id, { status: "stitching", gate: null, revise_comment: null });
    } else {
      await enqueueJob(run.id, "keyframes", { shotIndex: nextShot });
      await updateRun(run.id, { status: "generating", gate: null, current_shot_index: nextShot, revise_comment: null });
    }
  } else {
    await enqueueJob(run.id, "stitch");
    await updateRun(run.id, { status: "stitching", gate: null, revise_comment: null });
  }
}

/** Reopen an exported (or idle) run on a prior shot so you can fix + restitch. */
export async function reopenShot(runId: string, shotIndex: number, gate: "keyframe" | "clip" = "clip"): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown run");
  if (run.status === "generating" || run.status === "stitching" || run.status === "queued") {
    throw new Error(`Run is busy (${run.status}); wait for it to idle first.`);
  }
  const script = parseScript(run);
  if (shotIndex < 0 || shotIndex >= script.shots.length) {
    throw new Error(`Shot ${shotIndex} out of range (0–${script.shots.length - 1})`);
  }
  if (await runHasBusyJobs(run.id)) throw new Error("Clear or finish pending jobs before reopening a shot.");
  await updateRun(run.id, {
    status: "waiting_human",
    gate,
    current_shot_index: shotIndex,
    revise_comment: null,
    error: null,
  });
}

async function downstreamClipsSelected(runId: string, script: ScriptPlan, fromShot: number): Promise<boolean> {
  for (let i = fromShot; i < script.shots.length; i++) {
    if (!(await listVariants(runId, i, "clip")).some((v) => v.selected)) return false;
  }
  return true;
}

export async function rejectClips(runId: string, comment: string): Promise<void> {
  const run = await requireWaiting(runId, "clip");
  const note = comment.trim();
  if (!note) throw new Error("Write a direction for the next generation before rejecting.");
  await rejectBatch(run.id, run.current_shot_index, "clip");
  await updateRun(run.id, { revise_comment: note });
  bumpRework(run);
  await enqueueJob(run.id, "clips", { shotIndex: run.current_shot_index });
}

export async function editClip(runId: string, variantId: string, comment: string): Promise<void> {
  const run = await requireWaiting(runId, "clip");
  const note = comment.trim();
  if (!note) throw new Error("Write the one change to make on this take.");
  const v = await getVariant(variantId);
  if (!v || v.run_id !== runId || v.kind !== "clip" || v.shot_index !== run.current_shot_index) {
    throw new Error("Select the take you want to keep, then request the fix.");
  }
  await updateRun(run.id, { revise_comment: note });
  bumpRework(run);
  await enqueueJob(run.id, "clips", { shotIndex: run.current_shot_index, sourceVariantId: variantId });
}

export async function approveFinal(runId: string, checklist: Checklist, useXfade: boolean): Promise<void> {
  const run = await requireWaiting(runId, "audit");
  if (!checklistComplete(checklist)) throw new Error("Final checklist must be all-pass");
  const prev = await getReview(run.id);
  await upsertReview({
    run_id: run.id,
    gate: "audit",
    checklist_json: JSON.stringify(checklist),
    aesthetic_score: prev?.aesthetic_score ?? null,
    consistency_score: prev?.consistency_score ?? null,
    use_xfade: useXfade ? 1 : prev?.use_xfade ?? 0,
  });
  await enqueueJob(run.id, "export");
  await updateRun(run.id, { status: "generating", gate: null });
}

export async function failFinal(runId: string, comment: string): Promise<void> {
  const run = await requireWaiting(runId, "audit");
  const note = comment.trim();
  if (!note) throw new Error("Write a direction for the next generation before rejecting.");
  await updateRun(run.id, { revise_comment: note });
  bumpRework(run);
  await updateRun(run.id, { status: "rework", gate: "clip" });
  await rejectBatch(run.id, Math.max(0, run.current_shot_index), "clip");
  await enqueueJob(run.id, "clips", { shotIndex: Math.max(0, run.current_shot_index) });
}

async function bumpRework(run: RunRow): Promise<void> {
  await updateRun(run.id, {
    status: "generating",
    rework_round: run.rework_round + 1,
    gate: null,
    error: null,
  });
}

async function requireWaiting(runId: string, gate: string): Promise<RunRow> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown run");
  if (run.status !== "waiting_human" || run.gate !== gate) {
    throw new Error(`Run is not waiting on ${gate} (status=${run.status} gate=${run.gate})`);
  }
  return run;
}

export async function deleteRun(runId: string): Promise<{ id: string; diskError?: string }> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown run");
  const dir = runDir(run.id);
  const sessionId = run.session_id;
  const exported = run.status === "exported" || run.counted === 1;
  await deleteRunRows(run.id);
  if (exported) purgeSessionFromDataset(sessionId);
  try {
    await deleteRunPrefix(run.id);
  } catch (err) {
    console.error(`[storage] deleteRunPrefix ${run.id}`, err);
  }
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch (err) {
    return { id: runId, diskError: err instanceof Error ? err.message : String(err) };
  }
  return { id: runId };
}

export async function retryRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown run");
  if (run.status !== "failed" && !(run.status === "waiting_human" && run.gate === "clip")) {
    throw new Error("Only failed runs (or partial clip batches) can retry");
  }

  // Drop stale queue entries so resume does not double-bill alongside a leftover job.
  const ts = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE jobs SET status='error', error=?, updated_at=? WHERE run_id=? AND status IN ('pending','running')`,
    )
    .run("Superseded by scene resume", ts, run.id);

  if (run.pipeline_mode === "task") {
    await updateRun(run.id, {
      status: "queued",
      error: "Resuming the deliverables…",
      gate: null,
      script_json: null,
      current_shot_index: 0,
    });
    await enqueueJob(run.id, "argon_execute");
    return;
  }

  if (isDocRun(run)) {
    await updateRun(run.id, {
      status: "generating",
      error: `Resuming document cook (${run.pipeline_mode})…`,
      gate: null,
      current_shot_index: 0,
    });
    await enqueueJob(run.id, "doc_cook");
    return;
  }

  if (isAudioRun(run)) {
    if (!run.script_json) {
      await updateRun(run.id, {
        status: "generating",
        error: "Resuming — planning audio cues…",
        gate: null,
        current_shot_index: 0,
      });
      await enqueueJob(run.id, "audio_plan");
      return;
    }
    const plan = parseAudioPlan(run);
    await updateRun(run.id, { status: "generating", gate: null, error: "Resuming audio cook…" });
    // Plate / tour assembly: keep EDL when present; otherwise re-plan (still assembly path).
    if (plan.assembly || plan.tour_assembly) {
      if (plan.assembly_edl_json || plan.tour_assembly) {
        await updateRun(run.id, {
          status: plan.tour_assembly || plan.assembly ? "stitching" : "generating",
          error: plan.tour_assembly
            ? "Resuming tour assembly…"
            : "Resuming podcast assembly from EDL…",
        });
        await enqueueJob(run.id, "audio_assemble");
        return;
      }
      await updateRun(run.id, {
        script_json: null,
        error: "Resuming — re-planning plate assembly…",
      });
      await enqueueJob(run.id, "audio_plan");
      return;
    }
    if (plan.music_only) {
      const musicDir = path.join(runDir(run.id), "audio", "music");
      const hasMusic = ["bed.wav", "bed.mp3"].some((n) => {
        const p = path.join(musicDir, n);
        return fs.existsSync(p) && fs.statSync(p).size > 256;
      });
      await enqueueJob(run.id, hasMusic ? "audio_mix" : "audio_music");
      return;
    }
    const speechDir = path.join(runDir(run.id), "audio", "speech");
    const missingSpeech = plan.cues.some((c) => {
      const p = path.join(speechDir, `cue_${c.index}.wav`);
      return !(fs.existsSync(p) && fs.statSync(p).size > 256);
    });
    const musicDir = path.join(runDir(run.id), "audio", "music");
    const hasMusic =
      ["bed.wav", "bed.mp3"].some((n) => {
        const p = path.join(musicDir, n);
        return fs.existsSync(p) && fs.statSync(p).size > 256;
      });
    const master = path.join(runDir(run.id), "final.m4a");
    if (missingSpeech) await enqueueJob(run.id, "audio_speech");
    else if (!hasMusic) await enqueueJob(run.id, "audio_music");
    else if (!fs.existsSync(master)) await enqueueJob(run.id, "audio_mix");
    else await enqueueJob(run.id, "audio_mix");
    return;
  }

  if (!run.script_json) {
    if (run.status !== "failed") throw new Error("Only failed runs can retry without a storyboard");
    await updateRun(run.id, {
      status: "generating",
      error: "Resuming — writing storyboard…",
      gate: null,
      current_shot_index: 0,
    });
    await enqueueJob(run.id, "script");
    return;
  }

  const script = parseScript(run);
  const total = script.shots.length;
  // Checkpoint: first scene without a selected clip (prior keepers untouched).
  let shot = 0;
  for (; shot < total; shot++) {
    if (!(await listVariants(run.id, shot, "clip")).some((v) => v.selected && !v.rejected)) break;
  }

  if (shot >= total) {
    await updateRun(run.id, {
      status: "stitching",
      error: `All ${total} scenes kept — stitching…`,
      gate: null,
      current_shot_index: Math.max(0, total - 1),
    });
    await enqueueJob(run.id, "stitch");
    return;
  }

  const liveClips = (await listVariants(run.id, shot, "clip")).filter((v) => !v.rejected && fs.existsSync(v.path));
  const wantVariants = isAutoRun(run) ? 1 : loadModelsConfig().variantCount || VARIANT_COUNT_DEFAULT;
  const fillMoreClips =
    run.status === "waiting_human" &&
    run.gate === "clip" &&
    liveClips.length > 0 &&
    liveClips.length < wantVariants;
  if (run.status === "waiting_human" && !fillMoreClips) {
    throw new Error("Only failed runs (or partial clip batches) can retry");
  }

  const kf = (await listVariants(run.id, shot, "keyframe")).find((v) => v.selected);
  if (!kf) {
    await updateRun(run.id, {
      status: "generating",
      error: `Resume scene ${shot + 1}/${total} — keyframe…`,
      gate: null,
      current_shot_index: shot,
    });
    await enqueueJob(run.id, "keyframes", { shotIndex: shot });
    return;
  }

  await updateRun(run.id, {
    status: "generating",
    error: fillMoreClips
      ? `Resume scene ${shot + 1}/${total} — more clip takes…`
      : `Resume scene ${shot + 1}/${total} — clip (earlier scenes kept)…`,
    gate: null,
    current_shot_index: shot,
  });
  await enqueueJob(run.id, "clips", { shotIndex: shot });
}

export async function patchRunModels(
  runId: string,
  _patch: { scriptModel?: string; keyframeModel?: string; videoModel?: string },
): Promise<RunRow> {
  const run = await getRun(runId);
  if (!run) throw new Error("Unknown run");
  // Product autocook: models are code-locked (Argon + Omni). No UI / API overrides.
  throw new Error(
    "Session models are baked into Autocook and cannot be changed from the UI. Edit BRAIN_MODEL / PRODUCT_VIDEO_MODEL in code.",
  );
}

export type SceneProgress = {
  total: number;
  completed: number;
  current: number;
  nextAction: "script" | "keyframe" | "clip" | "stitch" | "done";
  scenes: Array<{
    index: number;
    duration: number;
    transition: ShotTransition;
    status: "done" | "current" | "pending";
    hasKeyframe: boolean;
    hasClip: boolean;
  }>;
};

export async function sceneProgressForRun(run: RunRow): Promise<SceneProgress | null> {
  if (!run.script_json) return null;
  let script: ScriptPlan;
  try {
    script = parseScript(run);
  } catch {
    return null;
  }
  const total = script.shots.length;
  let firstIncomplete = total;
  const scenes: SceneProgress["scenes"] = [];
  for (const s of script.shots) {
    const hasKeyframe = (await listVariants(run.id, s.index, "keyframe")).some(
      (v) => v.selected && !v.rejected,
    );
    const hasClip = (await listVariants(run.id, s.index, "clip")).some(
      (v) => v.selected && !v.rejected,
    );
    if (!hasClip && firstIncomplete === total) firstIncomplete = s.index;
    scenes.push({
      index: s.index,
      duration: s.duration,
      transition: resolveShotTransition(s, s.index),
      status: (hasClip ? "done" : firstIncomplete === s.index ? "current" : "pending") as
        | "done"
        | "current"
        | "pending",
      hasKeyframe,
      hasClip,
    });
  }
  // Fix status: only one current; pending after first incomplete
  for (const sc of scenes) {
    if (sc.hasClip) sc.status = "done";
    else if (sc.index === firstIncomplete) sc.status = "current";
    else sc.status = "pending";
  }
  const completed = scenes.filter((s) => s.status === "done").length;
  let nextAction: SceneProgress["nextAction"] = "done";
  if (firstIncomplete >= total) nextAction = run.status === "exported" ? "done" : "stitch";
  else if (!scenes[firstIncomplete]?.hasKeyframe) nextAction = "keyframe";
  else nextAction = "clip";
  return {
    total,
    completed,
    current: firstIncomplete >= total ? Math.max(0, total - 1) : firstIncomplete,
    nextAction,
    scenes,
  };
}

export async function runDetail(runId: string) {
  const run = await getRun(runId);
  if (!run) return null;
  // Interaction touch — delays 5h staging purge / 24h TTL while the user is looking.
  try {
    await updateRun(run.id, {});
  } catch {
    /* ignore */
  }
  const audio = isAudioRun(run);
  const doc = isDocRun(run);
  const task = run.pipeline_mode === "task";
  const taskDeliverables = task ? await loadTaskDeliverables(runId) : [];
  const script =
    !audio && !doc && run.script_json ? scriptPlanSchema.parse(JSON.parse(run.script_json)) : null;
  const audioPlan = audio && run.script_json ? parseAudioPlan(run) : null;
  const variants = await listVariants(runId);
  const assets = await listAssets(runId);
  const review = await getReview(runId);
  const stitchReportPath = path.join(runDir(runId), "stitch_report.json");
  const finalMp4 = path.join(runDir(runId), "final.mp4");
  const finalM4a = path.join(runDir(runId), "final.m4a");
  const finalWav = path.join(runDir(runId), "final.wav");
  const cleanWav = path.join(runDir(runId), "final_clean.wav");
  const syncedWav = path.join(runDir(runId), "final_synced.wav");
  for (const p of [stitchReportPath, finalMp4, finalM4a, finalWav, cleanWav, syncedWav]) {
    try {
      await ensureAbsRunFile(p);
    } catch {
      /* optional artifact */
    }
  }
  const stitch = fs.existsSync(stitchReportPath)
    ? JSON.parse(fs.readFileSync(stitchReportPath, "utf8"))
    : null;
  const finalPath = audio
    ? fs.existsSync(finalWav)
      ? finalWav
      : fs.existsSync(finalM4a)
        ? finalM4a
        : null
    : doc
      ? await resolveDocFinalPath(runId)
      : task
        ? (taskDeliverables[0]?.path ?? null)
        : fs.existsSync(finalMp4)
          ? finalMp4
          : null;
  const audioDeliverables = audio
    ? (
        [
          fs.existsSync(cleanWav) ? { id: "clean", label: "Clean instrumental", path: cleanWav } : null,
          fs.existsSync(syncedWav) ? { id: "synced", label: "Synced to monologue", path: syncedWav } : null,
          !fs.existsSync(cleanWav) && !fs.existsSync(syncedWav) && finalPath
            ? { id: "final", label: "Master", path: finalPath }
            : null,
        ] as Array<{ id: string; label: string; path: string } | null>
      ).filter((x): x is { id: string; label: string; path: string } => Boolean(x))
    : [];
  return {
    run,
    script,
    audioPlan,
    variants,
    assets,
    review,
    stitch,
    finalPath,
    audioDeliverables,
    deliverables: taskDeliverables,
    sceneProgress: audio || doc || task ? null : sceneProgressForRun(run),
  };
}
