/**
 * Argon brain planning — video/audio/html/image/pptx/pdf.
 * Argon owns structure; platform only snaps/writes/exports what the plan marks.
 * HTML/PPTX planning can call media tools (image/video/SVG) like gemini.google.com.
 */
import fs from "node:fs";
import path from "node:path";
import { brainCompletion, brainWithTools } from "../pipeline/geminiBrain";
import { BRAIN_MODEL, TYPICAL_AUTO_CLIP_SEC } from "../pipeline/constants";
import { scriptPlanSchema, audioPlanSchema, type ScriptPlan, type AudioPlan } from "../pipeline/schema";
import {
  htmlPlanSchema,
  imagePlanSchema,
  pptxPlanSchema,
  pdfPlanSchema,
  type HtmlPlan,
  type ImagePlan,
  type PptxPlan,
  type PdfPlan,
} from "../pipeline/schemaDocs";
import { inferCookKind } from "./inferCookKind";
import {
  ARGON_MEDIA_TOOL_DECLARATIONS,
  executeArgonMediaTool,
  type MediaToolContext,
} from "./argonMediaTools";
import type { PlanCookInput, PlanCookResult } from "./types";

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Brain returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function estimateShotCount(durationSec: number): number {
  return Math.max(1, Math.min(24, Math.ceil(durationSec / TYPICAL_AUTO_CLIP_SEC)));
}

export async function planCook(input: PlanCookInput): Promise<PlanCookResult> {
  const mode = input.mode ?? inferCookKind(input.prompt, input.attachmentNames ?? []);
  switch (mode) {
    case "audio":
      return { mode: "audio", plan: await planAudio(input), brainModel: BRAIN_MODEL };
    case "html":
      return { mode: "html", plan: await planHtml(input), brainModel: BRAIN_MODEL };
    case "image":
      return { mode: "image", plan: await planImage(input), brainModel: BRAIN_MODEL };
    case "pptx":
      return { mode: "pptx", plan: await planPptx(input), brainModel: BRAIN_MODEL };
    case "pdf":
      return { mode: "pdf", plan: await planPdf(input), brainModel: BRAIN_MODEL };
    case "video":
    default:
      return { mode: "video", plan: await planVideo(input), brainModel: BRAIN_MODEL };
  }
}

async function planVideo(input: PlanCookInput): Promise<ScriptPlan> {
  const durationSec = input.durationSec ?? 30;
  const n = estimateShotCount(durationSec);
  const system = `You are the autocook storyboard brain (${BRAIN_MODEL}). YOU own scene count, durations, and delivery. Return ONE JSON object matching:
{"media_desc":string,"tags":string[],"subjects":string[],"setting":string,"visual_style":string,"content_safety_notes":string,"delivery_fps":number|null,"delivery_resolution":"1080p"|"4K"|null,"shots":[{"index":number,"duration":number,"image_prompt":string,"motion_prompt":string,"media_desc":string,"transition":"cut"|"continue"}]}
Rules:
- Choose how many shots the brief needs (suggest around ${n} for ~${durationSec}s). Sum of durations ≈ ${durationSec}s.
- Shot 0 transition must be "cut". Later: "continue" only for continuity; else "cut".
- image_prompt = opening still. motion_prompt = full clip instruction for the video model (no platform wrappers will be added).
- Aspect ${input.aspect ?? "16:9"}. Category ${input.category ?? "general"}.`;

  const raw = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: briefUser(input) },
    ],
  });
  const parsed = scriptPlanSchema.parse(parseJsonObject(raw));
  parsed.shots = parsed.shots.map((s, i) => ({
    ...s,
    index: i,
    transition: i === 0 ? "cut" : s.transition === "continue" ? "continue" : "cut",
  }));
  return parsed;
}

async function planAudio(input: PlanCookInput): Promise<AudioPlan> {
  const durationSec = input.durationSec ?? 45;
  const system = `You are the autocook audio brain (${BRAIN_MODEL}). Return ONE JSON object matching:
{"media_desc":string,"target_duration":number,"music":{"prompt":string,"instrumental":boolean},"cues":[{"index":0,"kind":"speech","start":number,"end":number,"text":string,"style":string|null,"voice":string|null}],"use_provided_speech":false,"dual_masters":false,"wav_bit_depth":16,"music_only":boolean,"plate_assembly":false,"assembly":false}
Rules:
- target_duration ≈ ${durationSec}.
- cues: one speech cue (or music_only with MUSIC ONLY cue).
- music.prompt is a detailed instrumental Lyria prompt.
- Prefer Sulafat voice when speech is present.`;

  const raw = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: briefUser(input) },
    ],
  });
  return audioPlanSchema.parse(parseJsonObject(raw));
}

async function planHtml(input: PlanCookInput): Promise<HtmlPlan> {
  const system = `You are the autocook HTML brain (${BRAIN_MODEL}). YOU own all file contents. The platform writes your files verbatim and never restyles them.

You have MEDIA TOOLS (same role as gemini.google.com): generate_image, generate_video, write_svg.
Call them BEFORE the final answer whenever the deliverable needs photos, textures, UI stills, video loops, or SVG marks.
After tools return, reference media with {{asset:ID}} in HTML/CSS/JS (platform rewrites to path or data URI). Also list every generated asset in the plan assets[].

When finished, return ONLY ONE JSON object (no markdown):
{"kind":"html","media_desc":string,"entry":"index.html","files":[{"path":string,"content":string}],"assets":[{"id":string,"format":"png"|"svg"|"mp4","filename":string,"prompt":string,"svg":string|null,"embed":"path"|"data_uri","width":number,"height":number,"duration_sec":number}],"screenshot":boolean,"export_pdf":boolean,"notes":string|null}
Rules:
- Emit a complete working deliverable (single-file or multi-file: html/css/js).
- For Three.js / WebGL / games: include the full JS (CDN importmap or inline) so entry runs offline or with CDN as the brief allows.
- Prefer generate_image/write_svg/generate_video over empty placeholders or hotlinked stock.
- embed=data_uri only for small png/svg that must be self-contained; mp4 always path.
- paths are relative. entry must exist in files.
- screenshot=true only if visual QA screenshot is useful. export_pdf=true only if the brief asks for PDF.
- Keep content_safety: no malware, no phishing chrome.`;

  const stagingDir = input.workDir
    ? path.join(input.workDir, "argon_media")
    : path.join(process.cwd(), ".tmp_argon_media");
  fs.mkdirSync(stagingDir, { recursive: true });
  const ctx: MediaToolContext = {
    stagingDir,
    staged: new Map(),
    referenceImagePaths: input.referenceImagePaths,
    onStatus: input.onStatus,
  };

  const raw = await brainWithTools({
    model: BRAIN_MODEL,
    system,
    user: briefUser(input),
    tools: ARGON_MEDIA_TOOL_DECLARATIONS,
    maxRounds: 12,
    onStatus: input.onStatus,
    onTool: (name, args) => executeArgonMediaTool(name, args, ctx),
  });

  // Persist tool-staged registry for generateHtml
  const registryPath = path.join(stagingDir, "staged.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify(
      [...ctx.staged.values()].map((s) => ({
        id: s.id,
        format: s.format,
        filename: s.filename,
        absPath: s.absPath,
        embed: s.embed,
        mime: s.mime,
        hasDataUri: Boolean(s.dataUri),
      })),
      null,
      2,
    ),
  );

  const parsed = htmlPlanSchema.parse(parseJsonObject(raw));
  // Merge tool-staged assets into plan if Argon omitted them
  const byId = new Map(parsed.assets.map((a) => [a.id, a]));
  for (const s of ctx.staged.values()) {
    if (s.format === "wav") continue;
    if (!byId.has(s.id)) {
      parsed.assets.push({
        id: s.id,
        format: s.format,
        filename: s.filename,
        prompt: "",
        svg: s.format === "svg" ? fs.readFileSync(s.absPath, "utf8") : undefined,
        embed: s.embed,
        width: 1024,
        height: 1024,
      });
    }
  }
  if (!parsed.files.some((f) => f.path === parsed.entry || f.path.replace(/^\.\//, "") === parsed.entry)) {
    parsed.entry = parsed.files[0]!.path;
  }
  return parsed;
}

async function planImage(input: PlanCookInput): Promise<ImagePlan> {
  const system = `You are the autocook image brain (${BRAIN_MODEL}). YOU own asset list and prompts/SVG.
Return ONE JSON object:
{"kind":"image","media_desc":string,"assets":[{"id":string,"format":"png"|"svg","width":number,"height":number,"prompt":string,"svg":string|null,"filename":string}],"notes":string|null}
Rules:
- format png: fill prompt for the image model; leave svg empty/null. Platform generates PNG from prompt only (no creative rewrite).
- format svg: put the FULL SVG document in svg; prompt may be empty. Platform writes svg verbatim.
- filenames end with .png or .svg matching format.
- Sizes match the brief (default 1024x1024 if unspecified).`;

  const raw = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: briefUser(input) },
    ],
  });
  return imagePlanSchema.parse(parseJsonObject(raw));
}

async function planPptx(input: PlanCookInput): Promise<PptxPlan> {
  const system = `You are the autocook PPTX brain (${BRAIN_MODEL}). YOU own slide structure and copy.

You may call generate_image / write_svg tools first (same as gemini.google.com) when slides need real visuals; then put matching image_slot.image_prompt (or rely on platform image_slot generation).
When finished return ONLY ONE JSON object:
{"kind":"pptx","media_desc":string,"width_in":13.333,"height_in":7.5,"slides":[{"index":0,"title":string,"notes":string,"elements":[{"type":"title"|"body"|"image_slot"|"shape","text":string,"x":number,"y":number,"w":number,"h":number,"image_prompt":string,"fill":string}]}],"export_pdf":boolean,"notes":string|null}
Rules:
- x,y,w,h are percentages of the slide (0–100).
- type title/body use text. image_slot uses image_prompt (platform generates PNG then embeds). shape may use fill hex.
- Prefer image_slot with a strong image_prompt over empty decorative boxes when the brief needs visuals.
- Cover the FULL brief in order. export_pdf=true only if the brief asks for PDF.
- Widescreen 16:9 unless the brief demands otherwise.`;

  const stagingDir = input.workDir
    ? path.join(input.workDir, "argon_media")
    : path.join(process.cwd(), ".tmp_argon_media");
  fs.mkdirSync(stagingDir, { recursive: true });
  const ctx: MediaToolContext = {
    stagingDir,
    staged: new Map(),
    referenceImagePaths: input.referenceImagePaths,
    onStatus: input.onStatus,
  };

  // PPTX tools: image + svg only (video not embedded in minimal OOXML yet)
  const pptxTools = ARGON_MEDIA_TOOL_DECLARATIONS.filter((t) => t.name !== "generate_video");

  const raw = await brainWithTools({
    model: BRAIN_MODEL,
    system,
    user: briefUser(input),
    tools: pptxTools,
    maxRounds: 10,
    onStatus: input.onStatus,
    onTool: (name, args) => executeArgonMediaTool(name, args, ctx),
  });
  const parsed = pptxPlanSchema.parse(parseJsonObject(raw));
  parsed.slides = parsed.slides.map((s, i) => ({ ...s, index: i }));

  // Wire tool-staged stills into image_slots via image_file so generatePptx does not re-roll.
  const stagedStill = [...ctx.staged.values()].filter((s) => s.format === "png" || s.format === "svg");
  let stillIdx = 0;
  for (const slide of parsed.slides) {
    for (const el of slide.elements) {
      if (el.type !== "image_slot" || el.image_file || stillIdx >= stagedStill.length) continue;
      const s = stagedStill[stillIdx++]!;
      el.image_file = s.absPath;
    }
  }
  if (stillIdx === 0 && stagedStill.length && parsed.slides[0]) {
    for (const s of stagedStill) {
      parsed.slides[0].elements.push({
        type: "image_slot",
        image_prompt: s.id,
        image_file: s.absPath,
        x: 55,
        y: 25,
        w: 40,
        h: 50,
        text: "",
        fill: undefined,
      });
    }
  }
  return parsed;
}

async function planPdf(input: PlanCookInput): Promise<PdfPlan> {
  // Route through html/pptx planners so Argon still gets media tools for the source.
  const probeSystem = `You are the autocook PDF brain (${BRAIN_MODEL}). Choose the source format only.
Return ONE JSON object: {"kind":"pdf","media_desc":string,"source":"html"|"pptx","notes":string|null}
Prefer html for documents/reports; pptx for slide decks.`;
  const probeRaw = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      { role: "system", content: probeSystem },
      { role: "user", content: briefUser(input) },
    ],
  });
  const probe = parseJsonObject(probeRaw) as { source?: string; media_desc?: string; notes?: string | null };
  const source = probe.source === "pptx" ? "pptx" : "html";
  if (source === "html") {
    const source_plan = { ...(await planHtml(input)), export_pdf: true as const, kind: "html" as const };
    return pdfPlanSchema.parse({
      kind: "pdf",
      media_desc: probe.media_desc || source_plan.media_desc,
      source: "html",
      source_plan,
      notes: probe.notes ?? null,
    });
  }
  const source_plan = { ...(await planPptx(input)), export_pdf: true as const, kind: "pptx" as const };
  return pdfPlanSchema.parse({
    kind: "pdf",
    media_desc: probe.media_desc || source_plan.media_desc,
    source: "pptx",
    source_plan,
    notes: probe.notes ?? null,
  });
}

function briefUser(input: PlanCookInput): string {
  return [
    `OPERATOR BRIEF:\n${input.prompt.trim()}`,
    input.attachmentText?.trim() ? `\nATTACHMENTS:\n${input.attachmentText.trim()}` : "",
    input.attachmentNames?.length ? `\nATTACHMENT NAMES:\n${input.attachmentNames.join(", ")}` : "",
  ].join("\n");
}
