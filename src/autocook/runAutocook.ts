/**
 * Full autocook: preflight → Argon plan → generate → assemble/export.
 * Modes: video | audio | html | image | pptx | pdf
 */
import fs from "node:fs";
import path from "node:path";
import { PRODUCT_VIDEO_MODEL } from "../pipeline/constants";
import { preflightCook } from "./preflightCook";
import { planCook } from "./planCook";
import { generateSegment } from "./generateSegment";
import { assemble } from "./assemble";
import { generateHtml } from "./generateHtml";
import { generateImages } from "./generateImage";
import { generatePptx } from "./generatePptx";
import { exportPdf } from "./exportPdf";
import { inferCookKind } from "./inferCookKind";
import type { RunAutocookInput, RunAutocookResult } from "./types";
import type { ScriptPlan } from "../pipeline/schema";
import type { HtmlPlan, PptxPlan } from "../pipeline/schemaDocs";

export async function runAutocook(input: RunAutocookInput): Promise<RunAutocookResult> {
  const mode = input.mode ?? inferCookKind(input.prompt, input.attachmentNames ?? []);
  fs.mkdirSync(input.workDir, { recursive: true });

  input.onStatus?.("Checking brief…");
  const preMode = mode === "audio" ? "audio" : mode === "video" ? "video" : "document";
  const pre = await preflightCook({
    prompt: input.prompt,
    mode: preMode,
    durationSec: input.durationSec,
    aspect: input.aspect,
    attachmentSummary: input.attachmentText,
    attachmentNames: input.attachmentNames,
  });
  if (pre.status === "hardBlock") {
    const msg = pre.risks
      .filter((r) => r.severity === "hard")
      .map((r) => r.message)
      .join(" | ");
    throw new Error(`Hard blocker: ${msg || "Cannot cook this brief without changes."}`);
  }
  const brief = pre.rewrittenBrief;
  if (pre.status === "softFixesApplied") {
    input.onStatus?.("Soft safety fixes applied — continuing…");
    fs.writeFileSync(path.join(input.workDir, "preflight.json"), JSON.stringify(pre, null, 2));
  }

  input.onStatus?.(`Planning (${mode}) with Argon…`);
  const planned = await planCook({
    prompt: brief,
    mode,
    durationSec: input.durationSec,
    aspect: input.aspect,
    category: input.category,
    attachmentText: input.attachmentText,
    attachmentNames: input.attachmentNames,
    workDir: input.workDir,
    referenceImagePaths: input.referenceImagePaths,
    onStatus: input.onStatus,
  });

  if (planned.mode === "audio") {
    const planPath = path.join(input.workDir, "audio_plan.json");
    fs.writeFileSync(planPath, JSON.stringify(planned.plan, null, 2));
    input.onStatus?.(`Audio plan written — use createRun({pipelineMode:'audio'}) for TTS/Lyria.`);
    return {
      mode: "audio",
      plan: planned.plan,
      brainModel: planned.brainModel,
    };
  }

  if (planned.mode === "html") {
    return runHtml(input, planned.plan, planned.brainModel);
  }
  if (planned.mode === "image") {
    return runImage(input, planned.plan, planned.brainModel);
  }
  if (planned.mode === "pptx") {
    return runPptx(input, planned.plan, planned.brainModel);
  }
  if (planned.mode === "pdf") {
    return runPdf(input, planned.plan, planned.brainModel);
  }

  const plan = planned.plan as ScriptPlan;
  fs.writeFileSync(path.join(input.workDir, "plan.json"), JSON.stringify(plan, null, 2));
  const aspect = input.aspect ?? "16:9";
  const segmentPaths: string[] = [];
  let previousClipPath: string | undefined;

  for (let i = 0; i < plan.shots.length; i++) {
    const segDir = path.join(input.workDir, `shot_${i}`);
    fs.mkdirSync(segDir, { recursive: true });
    const result = await generateSegment({
      shotIndex: i,
      plan,
      aspect,
      outputResolution: input.outputResolution,
      keyframeOutPath: path.join(segDir, "keyframe.png"),
      clipOutPath: path.join(segDir, "clip.mp4"),
      videoModel: input.videoModel ?? PRODUCT_VIDEO_MODEL,
      previousClipPath,
      onStatus: input.onStatus,
    });
    segmentPaths.push(result.clipPath);
    previousClipPath = result.clipPath;
  }

  const masterPath = path.join(input.workDir, "master.mp4");
  await assemble({
    clipPaths: segmentPaths,
    outPath: masterPath,
    aspect,
    outputResolution: input.outputResolution,
    targetDurationSec: input.durationSec,
    onStatus: input.onStatus,
  });

  return {
    mode: "video",
    plan,
    masterPath,
    segmentPaths,
    brainModel: planned.brainModel,
  };
}

async function runHtml(
  input: RunAutocookInput,
  plan: HtmlPlan,
  brainModel: string,
): Promise<RunAutocookResult> {
  const html = await generateHtml({
    plan,
    outDir: input.workDir,
    referenceImagePaths: input.referenceImagePaths,
    onStatus: input.onStatus,
  });
  const deliverablePaths = [...html.written];
  if (html.zipPath) deliverablePaths.push(html.zipPath);
  if (html.screenshotPath) deliverablePaths.push(html.screenshotPath);
  let masterPath = html.zipPath ?? html.entryPath;
  if (plan.export_pdf) {
    const pdf = await exportPdf({
      sourcePath: html.entryPath,
      outDir: input.workDir,
      onStatus: input.onStatus,
    });
    deliverablePaths.push(pdf.pdfPath);
    masterPath = pdf.pdfPath;
  }
  return {
    mode: "html",
    plan,
    masterPath,
    deliverablePaths,
    brainModel,
  };
}

async function runImage(
  input: RunAutocookInput,
  plan: import("../pipeline/schemaDocs").ImagePlan,
  brainModel: string,
): Promise<RunAutocookResult> {
  const images = await generateImages({
    plan,
    outDir: input.workDir,
    referenceImagePaths: input.referenceImagePaths,
    onStatus: input.onStatus,
  });
  return {
    mode: "image",
    plan,
    masterPath: images.paths[0],
    deliverablePaths: images.paths,
    brainModel,
  };
}

async function runPptx(
  input: RunAutocookInput,
  plan: PptxPlan,
  brainModel: string,
): Promise<RunAutocookResult> {
  const deck = await generatePptx({ plan, outDir: input.workDir, onStatus: input.onStatus });
  const deliverablePaths = [deck.pptxPath, ...deck.imagePaths];
  let masterPath = deck.pptxPath;
  if (plan.export_pdf) {
    const pdf = await exportPdf({
      sourcePath: deck.pptxPath,
      outDir: input.workDir,
      onStatus: input.onStatus,
    });
    deliverablePaths.push(pdf.pdfPath);
    masterPath = pdf.pdfPath;
  }
  return {
    mode: "pptx",
    plan,
    masterPath,
    deliverablePaths,
    brainModel,
  };
}

async function runPdf(
  input: RunAutocookInput,
  plan: import("../pipeline/schemaDocs").PdfPlan,
  brainModel: string,
): Promise<RunAutocookResult> {
  const source = plan.source_plan;
  if (source.kind === "html") {
    const html = await generateHtml({
      plan: { ...source, export_pdf: true },
      outDir: input.workDir,
      referenceImagePaths: input.referenceImagePaths,
      onStatus: input.onStatus,
    });
    const pdf = await exportPdf({
      sourcePath: html.entryPath,
      outDir: input.workDir,
      onStatus: input.onStatus,
    });
    return {
      mode: "pdf",
      plan,
      masterPath: pdf.pdfPath,
      deliverablePaths: [pdf.pdfPath, html.entryPath, ...html.written],
      brainModel,
    };
  }
  const deck = await generatePptx({
    plan: { ...source, export_pdf: true },
    outDir: input.workDir,
    onStatus: input.onStatus,
  });
  const pdf = await exportPdf({
    sourcePath: deck.pptxPath,
    outDir: input.workDir,
    onStatus: input.onStatus,
  });
  return {
    mode: "pdf",
    plan,
    masterPath: pdf.pdfPath,
    deliverablePaths: [pdf.pdfPath, deck.pptxPath, ...deck.imagePaths],
    brainModel,
  };
}
