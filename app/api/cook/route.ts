import { fail, ok } from "@/src/api";
import { isAuthError, requireUser } from "@/src/auth/resolve";
import { CATEGORIES, normalizeOutputResolution, type Category, type VideoAspect } from "@/src/pipeline/constants";
import { ensureRailwaySchema } from "@/src/pipeline/ensureSchema";
import { createRun } from "@/src/pipeline/orchestrator";

function inferAspect(prompt: string): VideoAspect {
  if (/\b9\s*:\s*16\b|\bvertical\b|\breels?\b|\btiktok\b/i.test(prompt)) return "9:16";
  if (/\b1\s*:\s*1\b|\bsquare\b/i.test(prompt)) return "1:1";
  if (/\b2\.35\s*:\s*1\b|\bcinemascope\b|\bwidescreen\b/i.test(prompt)) return "2.35:1";
  return "16:9";
}

/**
 * One task per submission. The body is the operator prompt and files.
 * A deliverable kind is not part of the request. Argon decides the files.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    await ensureRailwaySchema();
    const ct = req.headers.get("content-type") ?? "";
    let prompt = "";
    let sessionLabel: string | undefined;
    let category: Category = CATEGORIES[1] ?? CATEGORIES[0];
    let inputFiles: Array<{ originalName: string; data: Buffer }> = [];
    let requestId: string | undefined;

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      prompt = String(form.get("prompt") ?? "").trim();
      sessionLabel = String(form.get("sessionLabel") ?? "").trim() || undefined;
      requestId = String(form.get("requestId") ?? "").trim() || undefined;
      const cat = String(form.get("category") ?? "").trim();
      if (CATEGORIES.includes(cat as Category)) category = cat as Category;
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
        requestId?: string;
      };
      prompt = String(body.prompt ?? "").trim();
      sessionLabel = body.sessionLabel?.trim() || undefined;
      requestId = body.requestId?.trim() || undefined;
      if (body.category && CATEGORIES.includes(body.category as Category)) {
        category = body.category as Category;
      }
    }

    if (!prompt) return fail("paste a task body to cook");

    const run = await createRun({
      prompt,
      category,
      duration: 1,
      aspect: inferAspect(prompt),
      pipelineMode: "task",
      sessionLabel,
      requestId,
      outputResolution: normalizeOutputResolution("1080p"),
      inputFiles: inputFiles.length ? inputFiles : undefined,
      userId: user.userId,
      tenantId: user.tenantId,
      createdByKind: user.kind,
    });

    return ok({
      blocked: false,
      fanout: false,
      task: true,
      stage: "plan",
      taskWeight: null,
      run,
    });
  } catch (err) {
    if (isAuthError(err)) return fail("unauthorized", 401);
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}
