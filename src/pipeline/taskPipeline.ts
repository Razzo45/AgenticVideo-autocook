/**
 * One brain session for the operator prompt and files.
 * The brain writes each deliverable. The platform builds the files.
 * A reply cut off by the output limit is continued. It is not rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import { ThinkingLevel, type Part } from "@google/genai";
import {
  MEDIA_TOOL_DECLARATIONS,
  executeMediaTool,
  type MediaToolContext,
} from "../autocook/mediaTools";
import {
  brainCompletion,
  brainCompletionText,
  brainGuidedWriteSvgThenJson,
  brainWithTools,
  type GuidedHtmlTarget,
  type GuidedSvgTarget,
} from "./geminiBrain";
import {
  DELIVERABLE_CONTINUATIONS,
  DELIVERABLE_MAX_OUTPUT_TOKENS,
  continuationFollowUp,
  isCutOffFinish,
  isCutOffParseError,
  jsonSliceParsable,
  stitchDeliverableText,
} from "./deliverableReceive";
import { BRAIN_MODEL } from "./constants";
import { brainLabel, type BrainLabel } from "./brainChoice";
import { hydrateRunInputs } from "./inputs";
import { classifyAttachment } from "./attachForBrain";
import { runDir } from "./paths";
import { stageLocalPath } from "./geminiStaging";
import crypto from "node:crypto";
import { deleteRunPrefix, ensureAbsRunFile, persistRunFile } from "./storage";
import { weightFromDeliverables, type PlannedDeliverable } from "./taskWeight";
import {
  buildComposition,
  composeInstructions,
  parseComposition,
  type Composition,
} from "./composition";
import { enqueueJob, updateRun, upsertAsset, type RunRow } from "../db";
import { withGeminiOwner } from "./geminiAdmission";
import { logStage, stage } from "./stageLog";
import { PlatformFaultError, isCancelledError, isPlatformFaultError } from "./runControl";
import {
  TASK_EXECUTE_JOB,
  TASK_SLICES_DIR,
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

function plannedFilenames(items: PlannedDeliverable[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    const name = String(item.filename ?? "").trim();
    if (name) names.push(name);
  }
  return names;
}

/** Filenames a pdf slice may point at with "from". Other slices get no extra list. */
export function pdfSiblingFilenames(planned: PlannedDeliverable[], slice: PlannedDeliverable[]): string[] {
  const wantsFrom = slice.some((item) => String(item.deliverable ?? "").trim().toLowerCase() === "pdf");
  if (!wantsFrom) return [];
  const here = new Set(plannedFilenames(slice).map((name) => name.toLowerCase()));
  return plannedFilenames(planned).filter((name) => !here.has(name.toLowerCase()));
}

function replyBreak(
  text: string,
  finish: string | undefined,
  parse: (raw: string) => void,
): "ok" | "cutoff" | "other" {
  try {
    parse(text);
    return "ok";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCutOffParseError(message)) return "cutoff";
    // The budget ran out and the text is not a finished object. Treat that as the same cut.
    if (isCutOffFinish(finish) && !jsonSliceParsable(text)) return "cutoff";
    return "other";
  }
}

/**
 * If the reply stopped inside the JSON, ask for the missing suffix and append it.
 * A reply that parses, or that failed for a real shape mistake, is returned as-is.
 */
async function continueCutOffJson(opts: {
  text: string;
  finishReason: string | undefined;
  model: string;
  userParts: Part[];
  activity: string;
  onStatus?: (msg: string) => void;
  onContinue?: () => void;
  parse: (raw: string) => void;
}): Promise<string> {
  let text = opts.text;
  let finish = opts.finishReason;
  for (let i = 0; i < DELIVERABLE_CONTINUATIONS; i++) {
    const broken = replyBreak(text, finish, opts.parse);
    if (broken !== "cutoff") return text;
    const followUp = continuationFollowUp();
    opts.onStatus?.(`${opts.activity} was cut off — continuing the same JSON…`);
    opts.onContinue?.();
    const next = await brainCompletionText({
      model: opts.model,
      messages: [{ role: "system", content: followUp }],
      userParts: opts.userParts,
      priorModelText: text,
      followUp,
      json: false,
      maxOutputTokens: DELIVERABLE_MAX_OUTPUT_TOKENS,
      continuable: true,
      thinkingLevel: ThinkingLevel.LOW,
      onStatus: opts.onStatus,
      activity: `${opts.activity} continuing`,
    });
    if (!next.text.trim()) break;
    const stitched = stitchDeliverableText(text, next.text);
    if (stitched === text) break;
    text = stitched;
    finish = next.finishReason;
  }
  return text;
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

function sameName(a: string | undefined, b: string | undefined): boolean {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  return Boolean(x) && x === y;
}

/**
 * One call writes the files it was asked for. A reply that also rewrites other
 * planned files is cut back to its own slice, so a task does not ship duplicates.
 * A single-file call whose reply renamed the file keeps the first deliverable.
 */
export function keepPlannedDeliverables<T extends { id: string; filename: string }>(
  slice: PlannedDeliverable[],
  written: T[],
): { kept: T[]; dropped: T[] } {
  if (!slice.length || written.length <= slice.length) return { kept: written, dropped: [] };
  const kept: T[] = [];
  const used = new Set<T>();
  for (const want of slice) {
    const hit =
      written.find((item) => !used.has(item) && sameName(item.filename, want.filename)) ??
      written.find((item) => !used.has(item) && sameName(item.id, want.id));
    if (hit) {
      used.add(hit);
      kept.push(hit);
    }
  }
  if (!kept.length) {
    const first = written.slice(0, slice.length);
    return { kept: first, dropped: written.slice(slice.length) };
  }
  return { kept, dropped: written.filter((item) => !used.has(item)) };
}

/** Identity of one execute call: the planned files it writes and the brain that writes them. */
export function sliceKey(slice: PlannedDeliverable[], model: string): string {
  const body = JSON.stringify({
    model,
    files: slice.map((item) => [item.deliverable ?? "", item.id ?? "", item.filename ?? "", item.note ?? ""]),
  });
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export function sliceCheckpointPath(dir: string, sliceIndex: number): string {
  return path.join(dir, TASK_SLICES_DIR, `slice_${sliceIndex + 1}.json`);
}

type SliceCheckpoint = { key: string; deliverables: Composition["deliverables"] };

/** The brain's finished reply for one planned file, saved the moment it is received. */
export async function saveSliceCheckpoint(
  dir: string,
  sliceIndex: number,
  key: string,
  deliverables: Composition["deliverables"],
): Promise<void> {
  const file = sliceCheckpointPath(dir, sliceIndex);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key, deliverables } satisfies SliceCheckpoint));
  try {
    // The worker disk does not survive a restart. The bucket copy is what a retry reads.
    await persistRunFile(file);
  } catch (err) {
    console.warn(`[task] checkpoint upload failed for ${path.basename(file)}`, err instanceof Error ? err.message : err);
  }
}

/** A saved reply for this exact slice, or null. A changed plan or brain does not match. */
export async function loadSliceCheckpoint(
  dir: string,
  sliceIndex: number,
  key: string,
): Promise<Composition["deliverables"] | null> {
  const file = sliceCheckpointPath(dir, sliceIndex);
  try {
    await ensureAbsRunFile(file);
  } catch {
    /* not saved */
  }
  if (!fs.existsSync(file)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as SliceCheckpoint;
    if (saved.key !== key || !Array.isArray(saved.deliverables) || !saved.deliverables.length) return null;
    return saved.deliverables;
  } catch {
    return null;
  }
}

/** How many planned files one task writes at the same time. */
export function sliceConcurrency(): number {
  const n = Math.floor(Number(process.env.TASK_SLICE_CONCURRENCY));
  return Number.isFinite(n) && n >= 1 ? Math.min(8, n) : 3;
}

/** Run work over items with a fixed number in flight. Results keep the input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return out;
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
  const { parts: userParts } = await stage(run.id, "plan inputs", () => operatorParts(run));
  await updateRun(run.id, { status: "generating", gate: null, error: `${label} is reading the task…` });
  const text = await stage(
    run.id,
    "plan brain",
    () =>
      brainCompletion({
        model,
        messages: [{ role: "system", content: planSystem(label) }],
        userParts,
        json: true,
      }),
    (reply) => ({ chars: reply.length }),
  );
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

  const { parts: userParts, placed } = await stage(run.id, "execute inputs", () => operatorParts(run));
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

  const writeSlice = async (slice: PlannedDeliverable[], sliceIndex: number): Promise<Composition["deliverables"]> => {
    const sliceStarted = Date.now();
    const key = sliceKey(slice, model);
    const saved = await loadSliceCheckpoint(dir, sliceIndex, key);
    if (saved) {
      logStage(run.id, `brain ${sliceIndex + 1}/${slices.length} reused`, 0, {
        files: saved.map((item) => item.filename).join(","),
      });
      return saved;
    }
    let continuations = 0;
    let lastFinish: string | undefined;
    const siblings = pdfSiblingFilenames(planned, slice);
    const system = composeInstructions(slice, attachedNames, label, siblings);
    const names = slice.map((item) => item.filename || item.deliverable).join(", ");
    const sliceLabel = `${label} ${sliceIndex + 1}/${slices.length} (${names})`;
    const svgSlice = slice.length >= 2 && slice.every(isSvgDeliverable);

    const parseSlice = (raw: string) =>
      parseComposition(raw, {
        stagedSvg: collectStagedSvg(toolCtx, filesByName),
        stagedHtml: collectStagedHtml(toolCtx, filesByName),
        filesByName,
      });
    const receive = (raw: string, finish: string | undefined, activity: string) =>
      continueCutOffJson({
        text: raw,
        finishReason: finish,
        model,
        userParts,
        activity,
        onStatus: onBrainStatus,
        onContinue: () => {
          continuations += 1;
        },
        parse: parseSlice,
      });

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
      text = await receive(text, undefined, sliceLabel);
    } else {
      const written = await brainCompletionText({
        model,
        messages: [{ role: "system", content: system }],
        userParts,
        json: true,
        maxOutputTokens: DELIVERABLE_MAX_OUTPUT_TOKENS,
        continuable: true,
        thinkingLevel: ThinkingLevel.LOW,
        onStatus: onBrainStatus,
        activity: sliceLabel,
      });
      if (!written.text.trim()) throw new Error(`${label} brain (${model}) returned no content`);
      lastFinish = written.finishReason;
      text = await receive(written.text, written.finishReason, sliceLabel);
    }

    let piece: Composition;
    try {
      piece = parseSlice(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCutOffParseError(message)) throw err;
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
        text = await receive(text, undefined, sliceLabel);
      } else {
        const rewritten = await brainCompletionText({
          model,
          messages: [{ role: "system", content: ping }],
          userParts: [
            ...userParts,
            { text: `The previous reply could not be built (${message}). Reply with the JSON object only.` },
          ],
          json: true,
          maxOutputTokens: DELIVERABLE_MAX_OUTPUT_TOKENS,
          continuable: true,
          thinkingLevel: ThinkingLevel.LOW,
          onStatus: onBrainStatus,
          activity: `${sliceLabel} rebuilding`,
        });
        if (!rewritten.text.trim()) throw new Error(`${label} brain (${model}) returned no content`);
        text = await receive(rewritten.text, rewritten.finishReason, `${sliceLabel} rebuilding`);
      }
      piece = parseSlice(text);
    }
    const { kept, dropped } = keepPlannedDeliverables(slice, piece.deliverables);
    if (dropped.length) {
      console.warn(
        `[task] run=${run.id} slice ${sliceIndex + 1}/${slices.length} wrote ${dropped.length} file(s) it was not asked for — dropped: ${dropped
          .map((item) => item.filename)
          .join(", ")}`,
      );
    }
    logStage(run.id, `brain ${sliceIndex + 1}/${slices.length} (${names})`, Date.now() - sliceStarted, {
      chars: text.length,
      finish: lastFinish,
      continuations,
      dropped: dropped.length || undefined,
    });
    await saveSliceCheckpoint(dir, sliceIndex, key, kept);
    return kept;
  };

  // Each planned file is its own brain call. They run side by side, each as its
  // own admission owner, so one task's files do not wait in line behind each other.
  // A file that fails does not stop the others: they finish and are saved, so a
  // retry writes only what is missing.
  const outcomes = await mapLimit(slices, sliceConcurrency(), (slice, sliceIndex) =>
    withGeminiOwner(`${run.id}:slice${sliceIndex + 1}`, () => writeSlice(slice, sliceIndex)).then(
      (deliverables) => ({ ok: true as const, deliverables }),
      (error: unknown) => ({ ok: false as const, error, slice }),
    ),
  );
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome]));
  if (failures.length) {
    const cancelled = failures.find((failure) => isCancelledError(failure.error));
    if (cancelled) throw cancelled.error;
    const first = failures[0]!;
    const message = first.error instanceof Error ? first.error.message : String(first.error);
    const missing = failures
      .flatMap((failure) => failure.slice.map((item) => item.filename || item.deliverable))
      .join(", ");
    const done = outcomes.length - failures.length;
    const summary = `${message} — ${done} of ${outcomes.length} file(s) are written and saved. Retry writes only: ${missing}.`;
    throw isPlatformFaultError(first.error) ? new PlatformFaultError(summary) : new Error(summary);
  }
  const written = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.deliverables] : []));
  const merged: Composition["deliverables"] = written.flat();
  // Two calls can still land on one filename. Keep the first.
  for (let i = merged.length - 1; i >= 0; i--) {
    const key = merged[i]!.filename.toLowerCase();
    if (merged.findIndex((item) => item.filename.toLowerCase() === key) !== i) {
      console.warn(`[task] run=${run.id} duplicate deliverable ${merged[i]!.filename} — dropped`);
      merged.splice(i, 1);
    }
  }
  if (!merged.length) throw new Error(`${label} finished without writing a deliverable`);

  const composition: Composition = { deliverables: merged };
  const compositionPath = taskCompositionWritePath(dir);
  fs.writeFileSync(compositionPath, JSON.stringify(composition, null, 2));
  await persistRunFile(compositionPath);

  const built = await stage(
    run.id,
    "build",
    () =>
      buildComposition({
        composition,
        workDir: dir,
        filesByName,
        ownerId: run.id,
        brainLabel: label,
        onStatus: (msg) => {
          void updateRun(run.id, { error: msg });
        },
      }),
    (files) => ({ files: files.length }),
  );
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

  // The files exist. The saved replies are no longer needed.
  fs.rmSync(path.join(dir, TASK_SLICES_DIR), { recursive: true, force: true });
  await deleteRunPrefix(run.id, TASK_SLICES_DIR).catch(() => undefined);

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
    const { runFileExists } = await import("./storage");
    const out: TaskDeliverable[] = [];
    for (const row of rows) {
      if (!row.path) continue;
      // A file that is only in the bucket still belongs on the list. Downloading
      // it here dropped anything slow or not yet on this disk, and the platform
      // then treated the shorter list as the whole cook.
      const local = fs.existsSync(row.path) && fs.statSync(row.path).size > 0;
      if (local || (await runFileExists(row.path))) out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}
