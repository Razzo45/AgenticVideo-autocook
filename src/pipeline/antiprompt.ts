import fs from "node:fs";
import path from "node:path";
import {
  ANTI_PROMPT_INJECT_CAP,
  ANTI_PROMPT_LINE_MAX,
  ANTI_PROMPT_OVERLAP,
  categorySlug,
} from "./constants";
import { RUNS_DIR } from "./paths";
import { antiPromptSchema, type AntiPromptRecord } from "./schema";

const LEGACY_FILE = path.join(RUNS_DIR, "anti_prompt.jsonl");
const FIELD_DIR = path.join(RUNS_DIR, "anti_prompt");

const FIELD_SLUGS = ["ecom", "drama", "anime", "creative", "misc"] as const;

function fieldPath(slug: string): string {
  return path.join(FIELD_DIR, `${slug}.jsonl`);
}

function parseLine(line: string): AntiPromptRecord | null {
  try {
    const parsed = antiPromptSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readJsonl(file: string): AntiPromptRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: AntiPromptRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
    const rec = parseLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

function rewriteJsonl(file: string, keep: (row: AntiPromptRecord) => boolean): void {
  if (!fs.existsSync(file)) return;
  const kept = readJsonl(file).filter(keep);
  fs.writeFileSync(file, kept.length ? kept.map((r) => JSON.stringify(r) + "\n").join("") : "", "utf8");
}

/** Full catalog for the UI. Storage stays rich so we can slice finer later. */
export function loadAntiPrompts(): AntiPromptRecord[] {
  const out: AntiPromptRecord[] = [];
  const seen = new Set<string>();
  for (const rec of [...readJsonl(LEGACY_FILE), ...FIELD_SLUGS.flatMap((slug) => readJsonl(fieldPath(slug)))]) {
    if (seen.has(rec.uniq_id)) continue;
    seen.add(rec.uniq_id);
    out.push(rec);
  }
  return out;
}

function loadFieldRecords(category: string): AntiPromptRecord[] {
  const slug = categorySlug(category);
  const fromField = readJsonl(fieldPath(slug));
  const fromLegacy = readJsonl(LEGACY_FILE).filter((r) => categorySlug(r.category) === slug);
  const seen = new Set<string>();
  const out: AntiPromptRecord[] = [];
  for (const rec of [...fromLegacy, ...fromField]) {
    if (seen.has(rec.uniq_id)) continue;
    seen.add(rec.uniq_id);
    out.push(rec);
  }
  return out;
}

export function appendAntiPrompt(record: AntiPromptRecord): void {
  const file = fieldPath(categorySlug(record.category));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
}

export function removeAntiPromptSession(sessionId: string): void {
  rewriteJsonl(LEGACY_FILE, (r) => r.session_id !== sessionId);
  for (const slug of FIELD_SLUGS) {
    rewriteJsonl(fieldPath(slug), (r) => r.session_id !== sessionId);
  }
}

export type AntiPromptSidecar = {
  category: string;
  fieldSlug: string;
  fieldTotal: number;
  records: AntiPromptRecord[];
};

export type PremiseLike = {
  media_desc: string;
  setting?: string;
  shots?: Array<{ media_desc: string }>;
};

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "over",
  "then",
  "than",
  "when",
  "what",
  "which",
  "while",
  "about",
  "after",
  "before",
  "their",
  "there",
  "here",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "been",
  "being",
  "not",
  "but",
  "you",
  "your",
  "our",
  "its",
  "his",
  "her",
  "she",
  "him",
  "they",
  "them",
  "who",
  "how",
  "why",
  "can",
  "will",
  "just",
  "also",
  "only",
  "very",
  "more",
  "most",
  "some",
  "any",
  "all",
  "one",
  "two",
  "out",
  "off",
  "onto",
  "upon",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/i)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function premiseText(record: PremiseLike): string {
  const shots = (record.shots ?? []).map((s) => s.media_desc).join(" ");
  return [record.media_desc, record.setting ?? "", shots].filter(Boolean).join(" ");
}

export function jaccardTokens(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Same-field "do not repeat" list: every occupied premise in the field,
 * closest to the new prompt first. Still/motion stay on disk.
 */
export function selectAntiPromptSidecar(category: string, query = ""): AntiPromptSidecar {
  const field = loadFieldRecords(category);
  const records = field
    .map((rec) => ({ rec, score: jaccardTokens(query, premiseText(rec)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, ANTI_PROMPT_INJECT_CAP)
    .map((x) => x.rec);
  return {
    category,
    fieldSlug: categorySlug(category),
    fieldTotal: field.length,
    records,
  };
}

export function closestCatalogHit(
  category: string,
  plan: PremiseLike,
): { score: number; media_desc: string } | null {
  const field = loadFieldRecords(category);
  const text = premiseText(plan);
  let best: { score: number; media_desc: string } | null = null;
  for (const rec of field) {
    const score = jaccardTokens(text, premiseText(rec));
    if (!best || score > best.score) best = { score, media_desc: rec.media_desc };
  }
  return best;
}

export function storyboardTooClose(category: string, plan: PremiseLike): { score: number; media_desc: string } | null {
  const hit = closestCatalogHit(category, plan);
  if (!hit || hit.score < ANTI_PROMPT_OVERLAP) return null;
  return hit;
}

function clip(text: string, max: number): string {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > Math.floor(max * 0.55) ? cut.slice(0, sp) : cut).trim()}…`;
}

function fingerprint(record: AntiPromptRecord): string {
  const head = clip(record.media_desc || record.setting || "", ANTI_PROMPT_LINE_MAX);
  const shots = (record.shots ?? [])
    .map((s) => {
      const premise = clip(s.media_desc, ANTI_PROMPT_LINE_MAX);
      if (!premise) return "";
      return `  ${s.index + 1}. ${premise}`;
    })
    .filter(Boolean);
  if (!head && !shots.length) return "";
  if (!shots.length) return `- ${head}`;
  return `- ${head}\n${shots.join("\n")}`;
}

/** Occupied premises only: session logline + panel media_desc. No still/motion. */
export function formatAntiPromptSidecar(sidecar: AntiPromptSidecar): string {
  const blocks = sidecar.records.map(fingerprint).filter(Boolean);
  if (!blocks.length) return `None yet in ${sidecar.category}.`;
  const extra =
    sidecar.fieldTotal > sidecar.records.length
      ? ` Showing the ${sidecar.records.length} closest of ${sidecar.fieldTotal} occupied premises in this field.`
      : ` All ${sidecar.fieldTotal} occupied premises in this field.`;
  return `Do not repeat these. Field: ${sidecar.category}.${extra}\n${blocks.join("\n")}`;
}

/** @deprecated Use formatAntiPromptSidecar — kept for any leftover callers. */
export function formatAntiPromptBlock(records: AntiPromptRecord[]): string {
  if (!records.length) return "None yet.";
  return formatAntiPromptSidecar({
    category: records[0]?.category ?? "mixed",
    fieldSlug: categorySlug(records[0]?.category ?? ""),
    fieldTotal: records.length,
    records,
  });
}
