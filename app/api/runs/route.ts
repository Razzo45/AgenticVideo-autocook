import { fail, ok } from "@/src/api";
import { isAuthError, requireUser } from "@/src/auth/resolve";
import {
  CATEGORIES,
  OUTPUT_RESOLUTIONS,
  PIPELINE_MODES,
  VIDEO_ASPECTS,
  durationBounds,
  normalizeOutputResolution,
  type Category,
  type OutputResolution,
  type PipelineMode,
  type VideoAspect,
} from "@/src/pipeline/constants";
import { createRun, sceneProgressForRun } from "@/src/pipeline/orchestrator";
import { liveStatus } from "@/src/pipeline/progress";
import { parseAutoOptions, type AutoOptions } from "@/src/pipeline/autoOptions";
import { listRunsForApi } from "@/src/db";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const runs = await listRunsForApi(user.userId);
    return ok({
      runs: await Promise.all(
        runs.map(async (run) => ({
          ...run,
          live: liveStatus(run),
          sceneProgress: run.pipeline_mode === "audio" ? null : await sceneProgressForRun(run),
        })),
      ),
      me: { userId: user.userId, kind: user.kind },
    });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

function parseAutoOptionsField(raw: unknown): AutoOptions | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "string") {
    try {
      return parseAutoOptions(JSON.parse(raw));
    } catch {
      return parseAutoOptions({});
    }
  }
  return parseAutoOptions(raw);
}

async function parseCreateBody(req: Request): Promise<{
  prompt: string;
  category: Category;
  duration: number;
  aspect: VideoAspect;
  scriptModel?: string;
  keyframeModel?: string;
  videoModel?: string;
  sessionLabel?: string;
  pipelineMode?: PipelineMode;
  operatorScript?: string;
  outputResolution?: OutputResolution;
  autoOptions?: AutoOptions;
  inputFiles?: Array<{ originalName: string; data: Buffer }>;
}> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const prompt = String(form.get("prompt") ?? "").trim();
    const category = String(form.get("category") ?? "") as Category;
    const aspect = String(form.get("aspect") ?? "") as VideoAspect;
    const duration = Number(form.get("duration"));
    const scriptModel = String(form.get("scriptModel") ?? "").trim() || undefined;
    const keyframeModel = String(form.get("keyframeModel") ?? "").trim() || undefined;
    const videoModel = String(form.get("videoModel") ?? "").trim() || undefined;
    const sessionLabel = String(form.get("sessionLabel") ?? "").trim() || undefined;
    const pipelineMode = (String(form.get("pipelineMode") ?? "auto").trim() || "auto") as PipelineMode;
    const operatorScript = String(form.get("operatorScript") ?? "").trim() || undefined;
    const outputResolution = normalizeOutputResolution(String(form.get("outputResolution") ?? "1080p"));
    const autoOptions = parseAutoOptionsField(form.get("autoOptions"));
    const inputFiles: Array<{ originalName: string; data: Buffer }> = [];
    for (const entry of form.getAll("inputs")) {
      if (!(entry instanceof File) || !entry.size) continue;
      inputFiles.push({
        originalName: entry.name || "input.bin",
        data: Buffer.from(await entry.arrayBuffer()),
      });
    }
    return {
      prompt,
      category,
      duration,
      aspect,
      scriptModel,
      keyframeModel,
      videoModel,
      sessionLabel,
      pipelineMode,
      operatorScript,
      outputResolution,
      autoOptions,
      inputFiles,
    };
  }
  const body = (await req.json()) as {
    prompt: string;
    category: Category;
    duration: number;
    aspect: VideoAspect;
    scriptModel?: string;
    keyframeModel?: string;
    videoModel?: string;
    sessionLabel?: string;
    pipelineMode?: PipelineMode;
    operatorScript?: string;
    outputResolution?: OutputResolution;
    autoOptions?: Partial<AutoOptions>;
  };
  return {
    ...body,
    outputResolution: normalizeOutputResolution(body.outputResolution),
    autoOptions: body.autoOptions ? parseAutoOptions(body.autoOptions) : undefined,
    inputFiles: undefined,
  };
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await parseCreateBody(req);
    if (!body.prompt?.trim()) return fail("prompt required");
    if (!CATEGORIES.includes(body.category)) return fail("invalid category");
    const mode = body.pipelineMode ?? "auto";
    if (!PIPELINE_MODES.includes(mode)) return fail("invalid pipelineMode");
    const aspect = mode === "audio" ? ("16:9" as VideoAspect) : body.aspect;
    if (mode !== "audio" && !VIDEO_ASPECTS.includes(aspect)) return fail("invalid aspect");
    const outputResolution = normalizeOutputResolution(body.outputResolution);
    if (mode !== "audio" && !OUTPUT_RESOLUTIONS.includes(outputResolution)) {
      return fail("invalid outputResolution");
    }
    const bounds = durationBounds(mode);
    if (body.duration < bounds.min || body.duration > bounds.max) {
      return fail(`duration must be ${bounds.min}–${bounds.max}s for ${mode} pipeline`);
    }
    if (mode === "direct") {
      const hasTextFile = body.inputFiles?.some((f) => /\.(md|txt|csv)$/i.test(f.originalName));
      if (!body.operatorScript?.trim() && !hasTextFile) {
        return fail("direct pipeline requires operatorScript or a .md/.txt attachment");
      }
    }
    const run = await createRun({
      ...body,
      aspect,
      outputResolution,
      pipelineMode: mode,
      userId: user.userId,
      tenantId: user.tenantId,
      createdByKind: user.kind,
    });
    return ok({ run });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}
