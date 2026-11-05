import { fail, ok } from "@/src/api";
import { isAuthError, requireUser } from "@/src/auth/resolve";
import {
  CATEGORIES,
  durationBounds,
  isDocPipelineMode,
  normalizeOutputResolution,
  type Category,
  type PipelineMode,
  type VideoAspect,
} from "@/src/pipeline/constants";
import { createRun } from "@/src/pipeline/orchestrator";
import { preflightCook } from "@/src/autocook/preflightCook";
import { inferCookKind } from "@/src/autocook/inferCookKind";
import type { CookKind } from "@/src/pipeline/schemaDocs";

function inferAspect(prompt: string): VideoAspect {
  if (/\b9\s*:\s*16\b|\bvertical\b|\breels?\b|\btiktok\b/i.test(prompt)) return "9:16";
  if (/\b1\s*:\s*1\b|\bsquare\b/i.test(prompt)) return "1:1";
  if (/\b2\.35\s*:\s*1\b|\bcinemascope\b|\bwidescreen\b/i.test(prompt)) return "2.35:1";
  return "16:9";
}

function cookToPipelineMode(kind: CookKind): PipelineMode {
  if (kind === "audio") return "audio";
  if (kind === "html" || kind === "image" || kind === "pptx" || kind === "pdf") return kind;
  return "auto";
}

function inferDuration(prompt: string, kind: CookKind): number {
  const mode = cookToPipelineMode(kind);
  const bounds = durationBounds(mode);
  const m = prompt.match(/\b(\d{1,3})\s*(?:s|sec|secs|seconds)\b/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return Math.min(bounds.max, Math.max(bounds.min, n));
  }
  if (isDocPipelineMode(mode)) return 1;
  return kind === "audio" ? 45 : 30;
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const ct = req.headers.get("content-type") ?? "";
    let prompt = "";
    let sessionLabel: string | undefined;
    let category: Category = CATEGORIES[1] ?? CATEGORIES[0];
    let inputFiles: Array<{ originalName: string; data: Buffer }> = [];
    let forcedKind: CookKind | undefined;
    let requestId: string | undefined;

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      prompt = String(form.get("prompt") ?? "").trim();
      sessionLabel = String(form.get("sessionLabel") ?? "").trim() || undefined;
      requestId = String(form.get("requestId") ?? "").trim() || undefined;
      const cat = String(form.get("category") ?? "").trim();
      if (CATEGORIES.includes(cat as Category)) category = cat as Category;
      const kindRaw = String(form.get("kind") ?? "").trim();
      if (kindRaw && ["video", "audio", "html", "image", "pptx", "pdf"].includes(kindRaw)) {
        forcedKind = kindRaw as CookKind;
      }
      for (const entry of form.getAll("inputs")) {
        if (!(entry instanceof File) || !entry.size) continue;
        inputFiles.push({
          originalName: entry.name || "input.bin",
          data: Buffer.from(await entry.arrayBuffer()),
        });
      }
    } else {
      const body = (await req.json()) as {
        prompt?: string;
        sessionLabel?: string;
        category?: string;
        kind?: string;
        requestId?: string;
      };
      prompt = String(body.prompt ?? "").trim();
      sessionLabel = body.sessionLabel?.trim() || undefined;
      requestId = body.requestId?.trim() || undefined;
      if (body.category && CATEGORIES.includes(body.category as Category)) {
        category = body.category as Category;
      }
      if (body.kind && ["video", "audio", "html", "image", "pptx", "pdf"].includes(body.kind)) {
        forcedKind = body.kind as CookKind;
      }
    }

    if (!prompt) return fail("paste a task body to cook");

    const names = inputFiles.map((f) => f.originalName);
    const kind = forcedKind ?? inferCookKind(prompt, names);
    const aspect = inferAspect(prompt);
    const duration = inferDuration(prompt, kind);
    const pipelineMode = cookToPipelineMode(kind);

    // Service-token cooks (mother platform / load tests) skip the Argon LLM preflight —
    // that call was taking 9–90s per enqueue under parallel burst.
    const preflight =
      user.kind === "service"
        ? {
            status: "clear" as const,
            risks: [],
            rewrittenBrief: prompt,
            notes: ["preflight skipped for service token"],
            brainModel: "none",
          }
        : await preflightCook({
            prompt,
            mode: isDocPipelineMode(pipelineMode)
              ? "document"
              : kind === "audio"
                ? "audio"
                : "video",
            durationSec: duration,
            aspect,
            attachmentNames: names,
          });

    if (preflight.status === "hardBlock") {
      return ok({
        blocked: true,
        preflight,
        run: null,
        kind,
      });
    }

    // All kinds (video / audio / html / image / pptx / pdf) enqueue the FIFO worker.
    // Shared GEMINI_API_KEY: maxParallelRuns=1 drains oldest job first across everyone.
    const run = await createRun({
      prompt: preflight.rewrittenBrief,
      category,
      duration,
      aspect,
      pipelineMode,
      sessionLabel,
      requestId,
      outputResolution: normalizeOutputResolution("1080p"),
      inputFiles: inputFiles.length ? inputFiles : undefined,
      userId: user.userId,
      tenantId: user.tenantId,
      createdByKind: user.kind,
      autoOptions:
        pipelineMode === "auto"
          ? {
              longCook: duration > 120,
              deliver4k: false,
              presenterIdentity: false,
              voiceGuidance: false,
              verbatimScript: true,
              brandLock: true,
              timedGraphics: false,
            }
          : undefined,
    });

    return ok({
      blocked: false,
      preflight,
      kind,
      run,
    });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}
