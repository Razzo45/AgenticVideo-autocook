/**
 * Document cooks (html / image / pptx / pdf) on the shared GDP-ported worker.
 * Lanes / heavy flags: see jobLanes.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { isDocPipelineMode, type DocPipelineMode } from "./constants";
import { runDir } from "./paths";
import { runAutocook } from "../autocook/runAutocook";
import { hydrateRunInputs } from "./inputs";
import { ensureAbsRunFile, persistRunFile } from "./storage";
import { sanitizeFinishedRun } from "./hygiene";
import { updateRun, upsertAsset, type RunRow } from "../db";

export function isDocRun(run: RunRow): boolean {
  return isDocPipelineMode(run.pipeline_mode);
}

export function docKind(run: RunRow): DocPipelineMode {
  if (!isDocPipelineMode(run.pipeline_mode)) {
    throw new Error(`Not a document run: ${run.pipeline_mode}`);
  }
  return run.pipeline_mode;
}

function canonicalFinalName(masterPath: string, kind: DocPipelineMode): string {
  const ext = path.extname(masterPath).toLowerCase();
  if (ext) return `final${ext}`;
  if (kind === "html") return "final.html";
  if (kind === "image") return "final.png";
  if (kind === "pptx") return "final.pptx";
  return "final.pdf";
}

/** Worker job: Argon plan → generate → assemble/export under runs/<id>/. */
export async function jobDocCook(run: RunRow): Promise<void> {
  const kind = docKind(run);
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });

  await updateRun(run.id, {
    status: "generating",
    gate: null,
    error: `Queued document cook (${kind}) — Argon planning…`,
  });

  const inputs = await hydrateRunInputs(run.input_assets_json);
  const referenceImagePaths = inputs
    .filter((a) => a.kind === "image" && a.path && fs.existsSync(a.path))
    .map((a) => a.path);
  const attachmentNames = inputs.map((a) => a.filename || path.basename(a.path));

  const result = await runAutocook({
    prompt: run.initial_prompt,
    mode: kind,
    durationSec: run.target_duration || undefined,
    aspect: (run.aspect_ratio as "16:9" | "9:16" | "1:1" | "2.35:1") || "16:9",
    category: run.category as never,
    attachmentNames,
    workDir: dir,
    referenceImagePaths,
    onStatus: async (msg) => await updateRun(run.id, { error: msg, status: "generating" }),
  });

  const masterPath = result.masterPath;
  if (!masterPath || !fs.existsSync(masterPath)) {
    throw new Error(`${kind} cook finished without a master file`);
  }

  const finalName = canonicalFinalName(masterPath, kind);
  const finalPath = path.join(dir, finalName);
  if (path.resolve(masterPath) !== path.resolve(finalPath)) {
    fs.copyFileSync(masterPath, finalPath);
  }

  const deliverablePaths = result.deliverablePaths ?? [masterPath];
  const cookResultPath = path.join(dir, "cook_result.json");
  fs.writeFileSync(
    cookResultPath,
    JSON.stringify(
      {
        kind,
        brainModel: result.brainModel,
        masterPath: finalPath,
        deliverablePaths,
        plan: result.plan,
      },
      null,
      2,
    ),
  );
  await persistRunFile(finalPath);
  await persistRunFile(cookResultPath);
  // Full tree commit + local clear happens in processJob; keep finals uploaded here early.

  // Store plan JSON for Runs UI (same column as video/audio plans).
  try {
    await updateRun(run.id, { script_json: JSON.stringify(result.plan) });
  } catch {
    /* plan may not be serializable — cook_result.json is enough */
  }

  await upsertAsset({
    uniq_id: `${run.id}_doc_final`,
    run_id: run.id,
    shot_index: null,
    role: "final",
    path: finalPath,
    parent_uniq_id: null,
    meta_json: JSON.stringify({
      cookKind: kind,
      brainModel: result.brainModel,
      deliverablePaths,
    }),
  });

  await updateRun(run.id, {
    status: "exported",
    counted: 0,
    gate: null,
    error: null,
  });
}

/** Known final.* names for document masters (run detail / download). */
export async function resolveDocFinalPath(runId: string): Promise<string | null> {
  const dir = runDir(runId);
  const candidates = [
    "final.pdf",
    "final.pptx",
    "final.html",
    "final.htm",
    "final.zip",
    "final.png",
    "final.jpg",
    "final.jpeg",
    "final.webp",
    "final.svg",
    "cook_result.json",
  ];
  for (const name of candidates) {
    const p = path.join(dir, name);
    try {
      await ensureAbsRunFile(p);
    } catch {
      /* not in bucket */
    }
  }
  for (const name of candidates.filter((n) => n !== "cook_result.json")) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  const resultPath = path.join(dir, "cook_result.json");
  if (fs.existsSync(resultPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { masterPath?: string };
      if (j.masterPath) {
        try {
          await ensureAbsRunFile(j.masterPath);
        } catch {
          /* ignore */
        }
        if (fs.existsSync(j.masterPath)) return j.masterPath;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}
