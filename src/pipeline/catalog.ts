import {
  collectModelList,
  listChatModels,
  listImageModels,
  listVideoModels,
  modelDurations,
  modelSupports1080p,
} from "./openrouter";
import { OMNI_DURATIONS, OMNI_PIPELINE_SLUG } from "./geminiOmni";
export type CatalogOption = {
  id: string;
  name: string;
  eligible1080p?: boolean | null;
  durations?: number[];
};

export type ModelCatalogs = {
  script: CatalogOption[];
  keyframe: CatalogOption[];
  video: CatalogOption[];
  error?: string;
};

let cache: { at: number; value: ModelCatalogs } | null = null;
const TTL_MS = 10 * 60 * 1000;

function displayName(m: Record<string, unknown>): string {
  const raw = String(m.name ?? "").trim();
  if (raw) {
    const colon = raw.indexOf(": ");
    if (colon > 0 && colon < 40) return raw.slice(colon + 2).trim() || raw;
    return raw;
  }
  const id = String(m.id ?? "");
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id || "Unknown";
}

function uniqueNames(options: CatalogOption[]): CatalogOption[] {
  const counts = new Map<string, number>();
  for (const o of options) counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
  return options.map((o) => {
    if ((counts.get(o.name) ?? 0) < 2) return o;
    const vendor = o.id.split("/")[0] ?? o.id;
    return { ...o, name: `${o.name} (${vendor})` };
  });
}

function sortByName(options: CatalogOption[]): CatalogOption[] {
  return [...options].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function isChatModel(m: Record<string, unknown>): boolean {
  const id = String(m.id ?? "");
  if (!id || id.includes(":batch")) return false;
  const arch = (m.architecture ?? {}) as Record<string, unknown>;
  const outputs = (arch.output_modalities ?? m.output_modalities ?? []) as unknown;
  const out = Array.isArray(outputs) ? outputs.map(String) : [];
  if (out.length && !out.includes("text")) return false;
  const inputs = (arch.input_modalities ?? []) as unknown;
  const inn = Array.isArray(inputs) ? inputs.map(String) : [];
  if (inn.length === 1 && inn[0] === "image" && !out.includes("text")) return false;
  return true;
}

export async function loadModelCatalogs(force = false): Promise<ModelCatalogs> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const [chatRaw, imageRaw, videoRaw] = await Promise.all([
      listChatModels(),
      listImageModels(),
      listVideoModels(),
    ]);
    const scriptFromOr = uniqueNames(
      sortByName(
        collectModelList(chatRaw)
          .filter(isChatModel)
          .map((m) => ({ id: String(m.id), name: displayName(m) }))
          .filter((o) => o.id),
      ),
    );
    const script = scriptFromOr;
    const keyframe = uniqueNames(
      sortByName(
        collectModelList(imageRaw)
          .map((m) => ({ id: String(m.id), name: displayName(m) }))
          .filter((o) => o.id),
      ),
    );
    const videoFromOr = uniqueNames(
      sortByName(
        collectModelList(videoRaw)
          .map((m) => ({
            id: String(m.id),
            name: displayName(m),
            eligible1080p: modelSupports1080p(m),
            durations: modelDurations(m),
          }))
          .filter((o) => o.id),
      ),
    );
    const omniOption: CatalogOption = {
      id: OMNI_PIPELINE_SLUG,
      name: "Gemini Omni 1.1 Flash (direct)",
      eligible1080p: true,
      durations: [...OMNI_DURATIONS],
    };
    const video = videoFromOr.some((o) => o.id === OMNI_PIPELINE_SLUG)
      ? videoFromOr
      : [omniOption, ...videoFromOr];
    const value = { script, keyframe, video };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const omniOption: CatalogOption = {
      id: OMNI_PIPELINE_SLUG,
      name: "Gemini Omni 1.1 Flash (direct)",
      eligible1080p: true,
      durations: [...OMNI_DURATIONS],
    };
    const fallback: ModelCatalogs = {
      script: [],
      keyframe: [],
      video: [omniOption],
      error: err instanceof Error ? err.message : String(err),
    };
    return fallback;
  }
}
