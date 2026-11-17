/**
 * One brain session for the operator prompt and files.
 * The brain writes each deliverable in one reply. The platform builds the files.
 */
import fs from "node:fs";
import path from "node:path";
import type { Part } from "@google/genai";
import {
  MEDIA_TOOL_DECLARATIONS,
  executeMediaTool,
  type MediaToolContext,
} from "../autocook/mediaTools";
import {
  brainCompletion,
  brainGuidedWriteSvgThenJson,
  brainWithTools,
  type GuidedHtmlTarget,
  type GuidedSvgTarget,
} from "./geminiBrain";
import { BRAIN_MODEL } from "./constants";
import { brainLabel, type BrainLabel } from "./brainChoice";
import { hydrateRunInputs } from "./inputs";
import { classifyAttachment } from "./attachForBrain";
import { runDir } from "./paths";
import { stageLocalPath } from "./geminiStaging";
import { ensureAbsRunFile, persistRunFile } from "./storage";
import { weightFromDeliverables, type PlannedDeliverable } from "./taskWeight";
import {
  buildComposition,
  composeInstructions,
  parseComposition,
  type Composition,
} from "./composition";
import { enqueueJob, updateRun, upsertAsset, type RunRow } from "../db";
import {
  TASK_EXECUTE_JOB,
  ensureTaskPlanFile,
  taskCompositionWritePath,
  taskPlanWritePath,
} from "./taskJobs";

/** Optional in-session tools for large SVG payloads — model may ignore them. */
const TASK_OPTIONAL_TOOLS = MEDIA_TOOL_DECLARATIONS.filter((tool) => tool.name === "write_svg");

/** Planned SVG files with stable ids/filenames for guided write_svg. */
export function plannedSvgTargets(items: PlannedDeliverable[]): GuidedSvgTarget[] {
  const out: GuidedSvgTarget[] = [];
  for (const [index, item] of items.entries()) {
    const kind = String(item.deliverable ?? "").trim().toLowerCase();
    if (kind !== "svg") continue;
    const filename = String(item.filename ?? "").trim() || `mark_${index + 1}.svg`;
    const id =
      String(item.id ?? "").trim() || path.basename(filename, path.extname(filename)) || `svg_${index + 1}`;
    out.push({
      id,
      filename,
      note: String(item.note ?? "").trim() || undefined,
    });
  }
  return out;
}

function isSvgDeliverable(item: PlannedDeliverable): boolean {
  return String(item.deliverable ?? "").trim().toLowerCase() === "svg";
}

/**
 * Execute in plan order: all SVGs as one guided session when there are 2+,
 * every other planned file as its own JSON call (no mixed html+video ping).
 */
export function plannedExecuteSlices(items: PlannedDeliverable[]): PlannedDeliverable[][] {
  const svgs = items.filter(isSvgDeliverable);
  if (svgs.length >= 2) {
    return [svgs, ...items.filter((item) => !isSvgDeliverable(item)).map((item) => [item])];
  }
  return items.map((item) => [item]);
}

/** Planned HTML files (ids/filenames). Execute still puts page bodies in JSON. */
export function plannedHtmlTargets(items: PlannedDeliverable[]): GuidedHtmlTarget[] {
  const out: GuidedHtmlTarget[] = [];
  for (const [index, item] of items.entries()) {
    const kind = String(item.deliverable ?? "").trim().toLowerCase();
    if (kind !== "html" && kind !== "webpage" && kind !== "website") continue;
    const filename = String(item.filename ?? "").trim() || `page_${index + 1}.html`;
    const id =
      String(item.id ?? "").trim() || path.basename(filename, path.extname(filename)) || `html_${index + 1}`;
    out.push({
      id,
      filename,
      note: String(item.note ?? "").trim() || undefined,
    });
  }
  return out;
}

export function planSystem(label: BrainLabel): string {
  return `You are ${label}. Read the operator message and the attached files.
Reply with JSON only:
{"deliverables":[{"deliverable":"image"|"svg"|"html"|"pdf"|"pptx"|"audio"|"video","id":"string","filename":"string","note":"what this file is"}]}
One object per file you will produce. Do not generate the files in this step. Do not rewrite the operator message.`;
}

function runBrain(run: RunRow): { model: string; label: BrainLabel } {
  const model = run.script_model?.trim() || BRAIN_MODEL;
  return { model, label: brainLabel(model) };
}

export type TaskDeliverable = { id: string; label: string; path: string };

export type TaskPlan = { deliverables: PlannedDeliverable[] };

export async function loadTaskPlan(runId: string): Promise<TaskPlan | null> {
  const file = await ensureTaskPlanFile(runId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TaskPlan;
    if (!Array.isArray(parsed.deliverables)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseTaskPlan(text: string): TaskPlan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const body = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  const parsed = JSON.parse(body) as { deliverables?: PlannedDeliverable[] };
  const deliverables = Array.isArray(parsed.deliverables) ? parsed.deliverables : [];
  return {
    deliverables: deliverables
      .map((item) => ({
        deliverable: String(item?.deliverable ?? (item as { type?: string }).type ?? "").trim(),
        id: String(item?.id ?? "").trim() || undefined,
        filename: String(item?.filename ?? "").trim() || undefined,
        note: String(item?.note ?? "").trim() || undefined,
        count: Number(item?.count) > 1 ? Math.round(Number(item.count)) : undefined,
      }))
      .filter((item) => item.deliverable),
  };
}

async function operatorParts(run: RunRow): Promise<{ parts: Part[]; placed: Map<string, string> }> {
  const inputs = await hydrateRunInputs(run.input_assets_json);
  const userParts: Part[] = [{ text: run.initial_prompt }];
  const placed = new Map<string, string>();
  const spillDir = path.join(runDir(run.id), "inputs", "_read");
  for (const file of inputs) {
    if (!file.path || !fs.existsSync(file.path)) continue;
    const name = file.filename || path.basename(file.path);
    const pieces = await classifyAttachment({ name, filePath: file.path, spillDir, placed });
    for (const piece of pieces) {
      if (piece.kind === "note") {
        userParts.push({ text: piece.text } as Part);
        continue;
      }
      userParts.push({ text: piece.label } as Part);
      if (piece.kind === "inline") {
        userParts.push({ inlineData: { mimeType: piece.mime, data: piece.data.toString("base64") } } as Part);
        continue;
      }
      const staged = await stageLocalPath(piece.path, piece.mime, { runId: run.id, forceStage: piece.forceStage });
      userParts.push(
        staged.kind === "inline"
          ? ({ inlineData: { mimeType: staged.mime, data: staged.data } } as Part)
          : ({ fileData: { fileUri: staged.data, mimeType: staged.mime } } as Part),
      );
    }
  }
  return { parts: userParts, placed };
}

function collectStagedSvg(
  toolCtx: MediaToolContext,
  filesByName: Map<string, string>,
): Map<string, string> {
  const stagedSvg = new Map<string, string>();
  for (const staged of toolCtx.staged.values()) {
    if (staged.format !== "svg" || !fs.existsSync(staged.absPath)) continue;
    const markup = fs.readFileSync(staged.absPath, "utf8");
    stagedSvg.set(staged.id, markup);
    stagedSvg.set(staged.filename, markup);
    stagedSvg.set(path.basename(staged.filename), markup);
    stagedSvg.set(path.basename(staged.filename).toLowerCase(), markup);
    filesByName.set(path.basename(staged.filename).toLowerCase(), staged.absPath);
  }
  return stagedSvg;
}

function collectStagedHtml(
  toolCtx: MediaToolContext,
  filesByName: Map<string, string>,
): Map<string, { content: string; path: string }> {
  const stagedHtml = new Map<string, { content: string; path: string }>();
  for (const staged of toolCtx.staged.values()) {
    if (staged.format !== "html" || !fs.existsSync(staged.absPath)) continue;
    const content = fs.readFileSync(staged.absPath, "utf8");
    const entry = { content, path: staged.htmlPath?.trim() || "index.html" };
    stagedHtml.set(staged.id, entry);
    stagedHtml.set(staged.filename, entry);
    stagedHtml.set(path.basename(staged.filename), entry);
    stagedHtml.set(path.basename(staged.filename).toLowerCase(), entry);
    filesByName.set(path.basename(staged.filename).toLowerCase(), staged.absPath);
  }
  return stagedHtml;
}

/** Plan step. The brain names the files. That list is the generation queue weight. */
export async function jobTaskPlan(run: RunRow): Promise<void> {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  const { model, label } = runBrain(run);
  await updateRun(run.id, { status: "generating", gate: null, error: `${label} is fetching the task files…` });
  const { parts: userParts } = await operatorParts(run);
  await updateRun(run.id, { status: "generating", gate: null, error: `${label} is reading the task…` });
  const text = await brainCompletion({
    model,
    messages: [{ role: "system", content: planSystem(label) }],
    userParts,
    json: true,
  });
  const plan = parseTaskPlan(text);
  const planFile = taskPlanWritePath(dir);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  await persistRunFile(planFile);
  const schedule = weightFromDeliverables(plan.deliverables);
  const summary = schedule.parts.map((part) => `${part.count} ${part.deliverable}`).join(", ");
  await enqueueJob(run.id, TASK_EXECUTE_JOB);
  await updateRun(run.id, {
    status: "queued",
    gate: null,
    error: `${label} is queued for deliverables (${summary}) — weight ${schedule.weight}`,
  });
}

export async function jobTaskExecute(run: RunRow): Promise<void> {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });
  const { model, label } = runBrain(run);
  await updateRun(run.id, { status: "generating", gate: null, error: `${label} is fetching the task files…` });

  const inputs = await hydrateRunInputs(run.input_assets_json);
  const filesByName = new Map<string, string>();
  for (const file of inputs) {
    if (!file.path || !fs.existsSync(file.path)) continue;
    const name = (file.filename || path.basename(file.path)).toLowerCase();
    filesByName.set(name, file.path);
  }

  const { parts: userParts, placed } = await operatorParts(run);
  for (const [name, abs] of placed) filesByName.set(name, abs);
  const plan = await loadTaskPlan(run.id);
  const planned = plan?.deliverables ?? [];
  const attachedNames = [...filesByName.keys()].sort();
  await updateRun(run.id, { status: "generating", gate: null, error: `${label} is writing the deliverables…` });

  const stagingDir = path.join(dir, "compose_media");
  fs.mkdirSync(stagingDir, { recursive: true });
  const toolCtx: MediaToolContext = {
    stagingDir,
    staged: new Map(),
    filesByName,
    namedReferencesOnly: true,
    brainLabel: label,
    // Ticker only — never force status generating (late updates were resurrecting failed runs).
    onStatus: (msg) => {
      void updateRun(run.id, { error: msg });
    },
  };

  const slices = plannedExecuteSlices(planned);
  const svgTargets = plannedSvgTargets(planned);
  const onBrainStatus = (msg: string) => {
    void updateRun(run.id, { error: msg });
  };
  const onBrainTool = (name: string, args: Record<string, unknown>) =>
    executeMediaTool(name, args, toolCtx);

  const merged: Composition["deliverables"] = [];
  for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
    const slice = slices[sliceIndex]!;
    const system = composeInstructions(slice, attachedNames, label);
    const names = slice.map((item) => item.filename || item.deliverable).join(", ");
    const sliceLabel = `${label} ${sliceIndex + 1}/${slices.length} (${names})`;
    const svgSlice = slice.length >= 2 && slice.every(isSvgDeliverable);

    let text: string;
    if (svgSlice) {
      text = await brainGuidedWriteSvgThenJson({
        model,
        system,
        userParts,
        svgTargets,
        tools: TASK_OPTIONAL_TOOLS,
        onStatus: onBrainStatus,
        onTool: onBrainTool,
      });
    } else {
      onBrainStatus(`${sliceLabel}…`);
      text = await brainCompletion({
        model,
        messages: [{ role: "system", content: system }],
        userParts,
        json: true,
        onStatus: onBrainStatus,
      });
    }

    const parseSlice = (raw: string) =>
      parseComposition(raw, {
        stagedSvg: collectStagedSvg(toolCtx, filesByName),
        stagedHtml: collectStagedHtml(toolCtx, filesByName),
      });

    let piece: Composition;
    try {
      piece = parseSlice(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ping = `${system}\n\nThe previous reply could not be built (${message}). Reply with the JSON object only.`;
      if (svgSlice) {
        text = await brainWithTools({
          model,
          system: `${ping} You may call write_svg again if needed.`,
          user: run.initial_prompt,
          userParts: [
            ...userParts,
            { text: `The previous reply could not be built (${message}). Reply with the JSON object only.` },
          ],
          tools: TASK_OPTIONAL_TOOLS,
          maxRounds: 16,
          onStatus: onBrainStatus,
          onTool: onBrainTool,
        });
      } else {
        text = await brainCompletion({
          model,
          messages: [
            { role: "system", content: ping },
            {
              role: "user",
              content: `The previous reply could not be built (${message}). Reply with the JSON object only.`,
            },
          ],
          userParts: [
            ...userParts,
            { text: `The previous reply could not be built (${message}). Reply with the JSON object only.` },
          ],
          json: true,
          onStatus: onBrainStatus,
        });
      }
      piece = parseSlice(text);
    }
    merged.push(...piece.deliverables);
  }

  const composition: Composition = { deliverables: merged };
  const compositionPath = taskCompositionWritePath(dir);
  fs.writeFileSync(compositionPath, JSON.stringify(composition, null, 2));
  await persistRunFile(compositionPath);

  const built = await buildComposition({
    composition,
    workDir: dir,
    filesByName,
    ownerId: run.id,
    brainLabel: label,
    onStatus: (msg) => {
      void updateRun(run.id, { error: msg });
    },
  });
  if (!built.length) throw new Error(`${label} finished without creating a file`);

  const deliverables: TaskDeliverable[] = [];
  for (const file of built) {
    deliverables.push({ id: file.id, label: file.filename, path: file.absPath });
    await persistRunFile(file.absPath);
    await upsertAsset({
      uniq_id: `${run.id}_${file.id}`,
      run_id: run.id,
      shot_index: null,
      role: "final",
      path: file.absPath,
      parent_uniq_id: null,
      meta_json: JSON.stringify({ cookKind: "task", filename: file.filename }),
    });
  }
  const manifest = path.join(dir, "deliverables.json");
  fs.writeFileSync(manifest, JSON.stringify(deliverables, null, 2));
  await persistRunFile(manifest);

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
