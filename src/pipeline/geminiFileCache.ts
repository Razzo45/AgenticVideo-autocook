/**
 * What to do with a cached Files API handle after `files.get`.
 * Ported from GDP `src/domain/geminiFileCache.ts`.
 */
export function cachedGeminiUriDecision(input: {
  getFailed: boolean;
  status?: number;
  state?: string | null;
  uri?: string | null;
}): "use" | "keep" | "drop" {
  if (input.getFailed) return input.status === 403 || input.status === 404 ? "drop" : "keep";
  const state = (input.state ?? "").toUpperCase();
  if (state === "ACTIVE" && input.uri) return "use";
  if (state === "PROCESSING") return "keep";
  return "drop";
}
