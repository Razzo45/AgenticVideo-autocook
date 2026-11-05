/**
 * Argon refusal preflight — soft risks auto-rewrite; hard blockers stop COOK.
 */
import { brainCompletion } from "../pipeline/geminiBrain";
import { BRAIN_MODEL } from "../pipeline/constants";

export type PreflightRisk = {
  severity: "soft" | "hard";
  field: string;
  message: string;
  suggestedFix: string;
};

export type PreflightResult = {
  status: "clear" | "softFixesApplied" | "hardBlock";
  risks: PreflightRisk[];
  /** Working brief after soft rewrites (same as input when clear). */
  rewrittenBrief: string;
  notes: string[];
  brainModel: string;
};

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Preflight returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export type PreflightCookInput = {
  prompt: string;
  mode?: "video" | "audio" | "document" | "html" | "image" | "pptx" | "pdf";
  durationSec?: number;
  aspect?: string;
  attachmentNames?: string[];
  attachmentSummary?: string;
};

/**
 * Check brief + attachments for Gemini generation refusal risk.
 * Soft: returns rewrittenBrief and status softFixesApplied (caller continues).
 * Hard: status hardBlock — user must fix before COOK continues.
 */
export async function preflightCook(input: PreflightCookInput): Promise<PreflightResult> {
  const mode = input.mode ?? "video";
  const isDoc = mode === "document" || mode === "html" || mode === "image" || mode === "pptx" || mode === "pdf";
  const system = `You are the autocook safety preflight for ${BRAIN_MODEL}.
Return ONE JSON object:
{"status":"clear"|"softFixesApplied"|"hardBlock","rewrittenBrief":string,"notes":string[],"risks":[{"severity":"soft"|"hard","field":string,"message":string,"suggestedFix":string}]}

Rules:
- soft = language that may trip generators but CAN be safely rephrased without changing the creative ask${isDoc ? " (for HTML/PPTX/PDF/image: phishing UI, malware scripts, illegal content)" : " (gore wording, weapon impact, copyrighted lyrics/artist clones, overly sexual, etc.)"}. Put the safer full brief in rewrittenBrief and list each soft risk.
- hard = cannot proceed without the user (required file missing when the brief demands it, empty brief, contradictory impossible ask${isDoc ? "" : ", duration/aspect that forbids crop when only Omni 16:9/9:16 exists and user forbids crop"}). rewrittenBrief may equal the input.
- clear = no changes; rewrittenBrief = original prompt.
- Prefer softFixesApplied over hardBlock whenever a rewrite preserves intent.
${!isDoc ? "- For aspect 1:1 or 2.35:1 note in notes that Omni will generate 16:9/9:16 then crop/pad — that is NOT a hard block unless the brief forbids any crop.\n" : ""}- Mode: ${mode}. Target duration ~${input.durationSec ?? "?"}s. Aspect ${input.aspect ?? "16:9"}.`;

  const user = [
    `OPERATOR BRIEF:\n${input.prompt.trim()}`,
    input.attachmentNames?.length
      ? `\nATTACHED FILES:\n${input.attachmentNames.map((n) => `- ${n}`).join("\n")}`
      : "\nATTACHED FILES: (none)",
    input.attachmentSummary?.trim() ? `\nATTACHMENT SUMMARY:\n${input.attachmentSummary.trim()}` : "",
  ].join("\n");

  const raw = await brainCompletion({
    model: BRAIN_MODEL,
    json: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const parsed = parseJsonObject(raw) as {
    status?: string;
    rewrittenBrief?: string;
    notes?: string[];
    risks?: Array<{
      severity?: string;
      field?: string;
      message?: string;
      suggestedFix?: string;
    }>;
  };

  const risks: PreflightRisk[] = (parsed.risks ?? [])
    .map((r) => ({
      severity: r.severity === "hard" ? ("hard" as const) : ("soft" as const),
      field: (r.field ?? "brief").trim() || "brief",
      message: (r.message ?? "").trim() || "Risk flagged",
      suggestedFix: (r.suggestedFix ?? "").trim() || "Rephrase to safer production language.",
    }))
    .filter((r) => r.message);

  const hasHard = risks.some((r) => r.severity === "hard") || parsed.status === "hardBlock";
  const rewrittenBrief = (parsed.rewrittenBrief ?? input.prompt).trim() || input.prompt.trim();
  const softChanged = rewrittenBrief !== input.prompt.trim() || risks.some((r) => r.severity === "soft");

  let status: PreflightResult["status"] = "clear";
  if (hasHard) status = "hardBlock";
  else if (softChanged || parsed.status === "softFixesApplied") status = "softFixesApplied";

  return {
    status,
    risks,
    rewrittenBrief: hasHard ? input.prompt.trim() : rewrittenBrief,
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    brainModel: BRAIN_MODEL,
  };
}
