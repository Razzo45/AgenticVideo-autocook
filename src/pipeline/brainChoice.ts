import { BRAIN_MODEL } from "./constants";

/** Gemini 4 Carbon. Argon stays `BRAIN_MODEL`. */
export const CARBON_BRAIN_MODEL = "gemini-4-carbon";

export type CookBrain = "argon" | "carbon";
export type BrainLabel = "Argon" | "Carbon";

/**
 * Task tag from the mother platform.
 * Empty stays Argon. `argon` / `gemini-4-argon` and `carbon` / `gemini-4-carbon` are the only other values.
 */
export function cookBrainFromInput(raw: unknown): CookBrain {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "argon" || value === BRAIN_MODEL) return "argon";
  if (value === "carbon" || value === CARBON_BRAIN_MODEL) return "carbon";
  throw new Error("brain must be argon or carbon");
}

export function modelForBrain(brain: CookBrain): string {
  return brain === "carbon" ? CARBON_BRAIN_MODEL : BRAIN_MODEL;
}

/** Display name for a stored script model. Anything that is not Carbon stays Argon. */
export function brainLabel(model: string | null | undefined): BrainLabel {
  const value = (model ?? "").trim().toLowerCase();
  if (value === "carbon" || value === CARBON_BRAIN_MODEL) return "Carbon";
  return "Argon";
}
