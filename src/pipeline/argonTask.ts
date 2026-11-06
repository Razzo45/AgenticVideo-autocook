/**
 * One Argon session for the operator prompt and files.
 * Tool arguments are executed as Argon sent them. The files those tools write are the downloads.
 */
import fs from "node:fs";
import path from "node:path";
import type { Part } from "@google/genai";
import { ARGON_MEDIA_TOOL_DECLARATIONS, executeArgonMediaTool, type MediaToolContext } from "../autocook/argonMediaTools";
import { brainWithTools } from "./geminiBrain";
import { BRAIN_MODEL } from "./constants";
import { hydrateRunInputs } from "./inputs";
import { runDir } from "./paths";
import { persistRunFile } from "./storage";
import { updateRun, upsertAsset, type RunRow } from "../db";

const SYSTEM = `You are Argon. The operator message and the attached files are the whole job.
Produce each deliverable by calling tools. Tool prompts and reference filenames are sent on unchanged.
Stop when those files exist.`;

export type TaskDeliverable = { id: string; label: string; path: string };

export async function jobArgonTask(run: RunRow): Promise<void> {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  await updateRun(run.id, { status: "generating", gate: null, error: "Argon is reading the task…" });

  const inputs = await hydrateRunInputs(run.input_assets_json);
  const filesByName = new Map<string, string>();
  for (const file of inputs) {
    if (!file.path || !fs.existsSync(file.path)) continue;
    const name = (file.filename || path.basename(file.path)).toLowerCase();
    filesByName.set(name, file.path);
  }

  const stagingDir = path.join(dir, "argon_media");
  const ctx: MediaToolContext = {
    stagingDir,
    staged: new Map(),
    filesByName,
    namedReferencesOnly: true,
    referenceImagePaths: [],
    onStatus: (msg) => {
      void updateRun(run.id, { error: msg, status: "generating" });
    },
  };

  const userParts: Part[] = [{ text: run.initial_prompt }];
  for (const file of inputs) {
    if (!file.path || !fs.existsSync(file.path)) continue;
    const name = file.filename || path.basename(file.path);
    const buf = fs.readFileSync(file.path);
    const lower = name.toLowerCase();
    if (/\.(png|jpe?g|webp|gif)$/i.test(lower)) {
      const mime = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
      userParts.push({ text: `Attached file: ${name}` } as Part);
      userParts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } } as Part);
    } else if (lower.endsWith(".pdf")) {
      userParts.push({ text: `Attached file: ${name}` } as Part);
      userParts.push({ inlineData: { mimeType: "application/pdf", data: buf.toString("base64") } } as Part);
    } else if (/\.(txt|md|json|csv|html)$/i.test(lower) && buf.length < 200_000) {
      userParts.push({ text: `Attached file ${name}:\n${buf.toString("utf8")}` } as Part);
    } else {
      userParts.push({ text: `Attached file: ${name}` } as Part);
    }
  }

  const notes = await brainWithTools({
    model: BRAIN_MODEL,
    system: SYSTEM,
    user: run.initial_prompt,
    userParts,
    tools: ARGON_MEDIA_TOOL_DECLARATIONS,
    maxRounds: 16,
    onStatus: async (msg) => {
      await updateRun(run.id, { error: msg, status: "generating" });
    },
    onTool: (name, args) => executeArgonMediaTool(name, args, ctx),
  });

  const staged = [...ctx.staged.values()];
  if (!staged.length) {
    throw new Error(notes.trim().slice(0, 500) || "Argon finished without creating a file");
  }

  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const deliverables: TaskDeliverable[] = [];
  for (const file of staged) {
    const base = path.basename(file.filename).replace(/[^\w.\-()+ ]+/g, "_") || `${file.id}.bin`;
    const dest = path.join(outDir, base);
    fs.copyFileSync(file.absPath, dest);
    deliverables.push({ id: file.id, label: file.id, path: dest });
    await persistRunFile(dest);
    await upsertAsset({
      uniq_id: `${run.id}_${file.id}`,
      run_id: run.id,
      shot_index: null,
      role: "final",
      path: dest,
      parent_uniq_id: null,
      meta_json: JSON.stringify({ cookKind: "task", filename: base }),
    });
  }
  const manifest = path.join(dir, "deliverables.json");
  fs.writeFileSync(manifest, JSON.stringify(deliverables, null, 2));
  await persistRunFile(manifest);
  if (notes.trim()) {
    const notesPath = path.join(dir, "argon_notes.txt");
    fs.writeFileSync(notesPath, notes);
    await persistRunFile(notesPath);
  }

  await updateRun(run.id, { status: "exported", counted: 0, gate: null, error: null });
}

export async function loadTaskDeliverables(runId: string): Promise<TaskDeliverable[]> {
  const manifest = path.join(runDir(runId), "deliverables.json");
  const { ensureAbsRunFile } = await import("./storage");
  try {
    await ensureAbsRunFile(manifest);
  } catch {
    /* not in the bucket yet */
  }
  if (!fs.existsSync(manifest)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(manifest, "utf8")) as TaskDeliverable[];
    const out: TaskDeliverable[] = [];
    for (const row of rows) {
      try {
        await ensureAbsRunFile(row.path);
      } catch {
        /* try the local copy */
      }
      if (row.path && fs.existsSync(row.path)) out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}
