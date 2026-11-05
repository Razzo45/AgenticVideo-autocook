import { fail, ok } from "@/src/api";
import { loadModelCatalogs } from "@/src/pipeline/catalog";
import { loadModelsConfig, videoModelMap } from "@/src/pipeline/config";

export const dynamic = "force-dynamic";

function maskKey(key: string | undefined): { present: boolean; masked: string } {
  if (!key || key === "replace-me") return { present: false, masked: "" };
  if (key.length < 8) return { present: true, masked: "••••" };
  return { present: true, masked: `${key.slice(0, 4)}…${key.slice(-4)}` };
}

export async function GET() {
  const cfg = loadModelsConfig();
  const catalogs = await loadModelCatalogs();
  return ok({
    models: cfg,
    videoForAspect: videoModelMap(cfg),
    catalogs,
    openrouter: maskKey(process.env.OPENROUTER_API_KEY),
    gemini: maskKey(process.env.GEMINI_API_KEY),
    resolution: "1080p",
    rejectedResolutions: ["720p", "4K as default delivery"],
  });
}

export async function PUT(_req: Request) {
  return fail(
    "Models are baked into Autocook and cannot be changed from Settings. Edit BRAIN_MODEL / PRODUCT_VIDEO_MODEL in code.",
    403,
  );
}
