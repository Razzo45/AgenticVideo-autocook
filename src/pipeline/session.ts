import { categorySlug } from "./constants";

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "then",
  "than",
  "when",
  "what",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "as",
  "is",
  "it",
  "or",
  "by",
  "be",
  "but",
  "not",
  "are",
  "was",
  "were",
  "very",
  "just",
  "make",
  "made",
  "video",
  "shot",
  "scene",
  "about",
]);

/** Short readable stem from operator text (prompt or a typed label). */
export function slugStem(text: string, maxWords = 5, maxChars = 42): string {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const picked: string[] = [];
  let len = 0;
  for (const w of words) {
    if (picked.length >= maxWords) break;
    const next = picked.length ? len + 1 + w.length : w.length;
    if (next > maxChars) break;
    picked.push(w);
    len = next;
  }
  return picked.join("-") || "untitled";
}

export function previewSessionId(category: string, prompt: string, label?: string): string {
  const field = categorySlug(category);
  const raw = label?.trim() ?? "";
  const asId = raw.match(/^sess_[a-z0-9]+_(.+)$/i);
  const source = asId ? asId[1] : raw || prompt;
  const stem = slugStem(source).replace(new RegExp(`^(?:${field}|sess)-+`), "");
  return `sess_${field}_${stem || "untitled"}`;
}

/** Dataset uniq_id from the session slug so parallel exports cannot share a 6-char tail. */
export function exportUniqId(sessionId: string, suffix: string): string {
  const stem = sessionId
    .replace(/^sess_/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `aigc_${stem || "untitled"}_${suffix}`;
}
