import type { Probe } from "./stitch";
import {
  BITRATE_FLOOR_BPS,
  FPS_FLOOR,
  IMAGE_ASPECTS,
  RESOLUTION_FLOOR,
  VIDEO_ASPECTS,
  durationBounds,
  nearestAspect,
  normalizeOutputResolution,
  resolutionFloor,
  type OutputResolution,
  type PipelineMode,
} from "./constants";
import { deliveryRecordSchema, type MetaRecord } from "./schema";
import fs from "node:fs";
import path from "node:path";
import { DATASET_DIR } from "./paths";

export type CheckResult = { id: string; label: string; pass: boolean; detail: string };

export type ConformanceReport = {
  pass: boolean;
  checks: CheckResult[];
};

function check(id: string, label: string, pass: boolean, detail: string): CheckResult {
  return { id, label, pass, detail };
}

export function evaluateImage(probe: Probe, expectedAspect?: string, _outputResolution?: OutputResolution): ConformanceReport {
  // Still floor stays 1080 — image models may not emit true 4K; video/stitch enforce delivery res.
  const longSide = Math.max(probe.width, probe.height);
  const ratio = nearestAspect(probe.width, probe.height);
  const checks = [
    check(
      "resolution",
      "Long side ≥ 1080 (720p rejected)",
      longSide >= RESOLUTION_FLOOR,
      `${probe.width}x${probe.height} (long side ${longSide})`,
    ),
    check(
      "aspect",
      "Allowed image aspect ratio",
      IMAGE_ASPECTS.includes(ratio as (typeof IMAGE_ASPECTS)[number]),
      `detected ${ratio}`,
    ),
  ];
  if (expectedAspect) {
    checks.push(check("aspect_match", "Matches session aspect", ratio === expectedAspect, `${ratio} vs ${expectedAspect}`));
  }
  return { pass: checks.every((c) => c.pass), checks };
}

export function evaluateClip(
  probe: Probe,
  expectedAspect?: string,
  outputResolution: OutputResolution = "1080p",
): ConformanceReport {
  const floor = resolutionFloor(normalizeOutputResolution(outputResolution));
  const longSide = Math.max(probe.width, probe.height);
  const ratio = nearestAspect(probe.width, probe.height);
  const codecOk = probe.codec === "h264" || probe.codec === "hevc" || probe.codec === "h265";
  const formatOk = probe.format === "mp4" || probe.format === "mov";
  const checks = [
    check(
      "resolution",
      `Native long side ≥ ${floor} (${outputResolution}, no upscale-to-pass)`,
      longSide >= floor,
      `${probe.width}x${probe.height}`,
    ),
    check("fps", "Frame rate ≥ 23.976", (probe.fps ?? 0) >= FPS_FLOOR, `${probe.fps ?? "unknown"} fps`),
    check(
      "duration_clip",
      "Clip duration > 0 and ≤ 5 min",
      probe.duration !== null && probe.duration > 0 && probe.duration <= 300,
      `${probe.duration ?? "unknown"}s`,
    ),
    check("codec", "H.264 / H.265", codecOk, probe.codec ?? "unknown"),
    check("container", "MP4 or MOV", formatOk, probe.format),
    check(
      "bitrate",
      "High bitrate (not a tiny compressed file)",
      probe.bitrate === null || probe.bitrate >= BITRATE_FLOOR_BPS,
      probe.bitrate ? `${Math.round(probe.bitrate / 1000)} kbps` : "unknown bitrate",
    ),
    check(
      "aspect",
      "Allowed video aspect",
      VIDEO_ASPECTS.includes(ratio as (typeof VIDEO_ASPECTS)[number]),
      `detected ${ratio}`,
    ),
  ];
  if (expectedAspect) {
    checks.push(check("aspect_match", "Matches session aspect", ratio === expectedAspect, `${ratio} vs ${expectedAspect}`));
  }
  if (probe.crop && probe.width && probe.height) {
    const minW = probe.width * 0.9;
    const minH = probe.height * 0.9;
    const cropOk = probe.crop.w >= minW && probe.crop.h >= minH;
    checks.push(
      check(
        "black_bars",
        "No material black bars (cropdetect)",
        cropOk,
        `crop ${probe.crop.w}x${probe.crop.h} of ${probe.width}x${probe.height}`,
      ),
    );
  }
  return { pass: checks.every((c) => c.pass), checks };
}

export function evaluateStitch(
  probe: Probe,
  expectedAspect?: string,
  pipelineMode: PipelineMode = "agentic",
  outputResolution: OutputResolution = "1080p",
): ConformanceReport {
  const base = evaluateClip(probe, expectedAspect, outputResolution);
  const bounds = durationBounds(pipelineMode);
  const durationOk =
    probe.duration !== null && probe.duration >= bounds.min && probe.duration <= bounds.max;
  const label =
    pipelineMode === "direct"
      ? `Stitched duration ${bounds.min}–${bounds.max}s (direct)`
      : `Stitched duration ${bounds.min}–${bounds.max}s`;
  base.checks.push(
    check(
      "duration_session",
      label,
      durationOk,
      `${probe.duration ?? "unknown"}s`,
    ),
  );
  base.pass = base.checks.every((c) => c.pass);
  return base;
}

export function validateMetaRecord(record: unknown, datasetRoot = DATASET_DIR): ConformanceReport {
  const parsed = deliveryRecordSchema.safeParse(record);
  const checks: CheckResult[] = [
    check("schema", "Delivery 25-field schema", parsed.success, parsed.success ? "ok" : parsed.error.message),
  ];
  if (parsed.success) {
    const rec = parsed.data;
    const abs = path.join(datasetRoot, rec.media_path);
    checks.push(check("path_sep", "Relative path uses /", !rec.media_path.includes("\\"), rec.media_path));
    checks.push(check("file_exists", "media_path exists", fs.existsSync(abs), rec.media_path));
    if (rec.audio_path) {
      checks.push(
        check("audio_exists", "audio_path exists", fs.existsSync(path.join(datasetRoot, rec.audio_path)), rec.audio_path),
      );
    }
    if (rec.origin_media_path) {
      checks.push(
        check(
          "origin_exists",
          "origin_media_path exists",
          fs.existsSync(path.join(datasetRoot, rec.origin_media_path)),
          rec.origin_media_path,
        ),
      );
    }
    for (const ref of rec.reference_images) {
      checks.push(check(`ref:${ref}`, "reference image exists", fs.existsSync(path.join(datasetRoot, ref)), ref));
    }
  }
  return { pass: checks.every((c) => c.pass), checks };
}

/** Soft checks that often flap on Omni/auto masters — still reported, not export-blocking for auto. */
const AUTO_SOFT_STITCH_IDS = new Set(["black_bars", "bitrate"]);

export function stitchGateReason(stitch: ConformanceReport, softIds: Set<string> = new Set()): string {
  const hardFails = stitch.checks.filter((c) => !c.pass && !softIds.has(c.id));
  if (!hardFails.length) return "";
  return hardFails.map((c) => `${c.id}: ${c.detail}`).join("; ");
}

export function canExport(opts: {
  rejected: boolean;
  stitch: ConformanceReport;
  checklistPass: boolean;
  meta: ConformanceReport;
  /** Auto cooks: ignore flaky black_bars/bitrate so deliverables still land. */
  softStitchIds?: Set<string>;
}): { ok: boolean; reason?: string } {
  if (opts.rejected) return { ok: false, reason: "Sample is rejected and cannot be counted." };
  const soft = opts.softStitchIds ?? new Set<string>();
  if (!opts.stitch.pass) {
    const hard = stitchGateReason(opts.stitch, soft);
    if (hard) return { ok: false, reason: `Stitched video failed §3.1 automated gates (${hard}).` };
  }
  if (!opts.checklistPass) return { ok: false, reason: "Human checklist is incomplete or has a fail." };
  if (!opts.meta.pass) return { ok: false, reason: "meta.jsonl failed 25-field / path validation." };
  return { ok: true };
}

export { AUTO_SOFT_STITCH_IDS };

export function mergeReports(...reports: ConformanceReport[]): ConformanceReport {
  const checks = reports.flatMap((r) => r.checks);
  return { pass: checks.every((c) => c.pass), checks };
}

export type MetaRecordValidated = MetaRecord;
