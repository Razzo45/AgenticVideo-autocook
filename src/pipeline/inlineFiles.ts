/**
 * {{inline:exact-name.ext}} — the platform pastes an attached file into the
 * brain's markup at build time. The brain names the file. It does not retype it.
 *
 * Text files (svg, css, html, js, json, txt, md) are pasted as their text.
 * Raster images become a data: URI. So does an SVG named inside src="…" or url(…).
 * An SVG's ids are prefixed per file, so two inlined marks that both use
 * id="glyph0-0" do not collide inside one HTML document.
 */
import fs from "node:fs";
import path from "node:path";

export const INLINE_TOKEN = /\{\{\s*inline\s*:\s*([^}]+?)\s*\}\}/g;

const TEXT_EXT = new Set([".svg", ".css", ".html", ".htm", ".js", ".mjs", ".json", ".txt", ".md", ".csv"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const INLINE_MAX_BYTES = 8 * 1024 * 1024;

/** Names used in {{inline:...}} tokens, in order of first use. */
export function inlineNames(content: string | undefined | null): string[] {
  if (!content) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of content.matchAll(INLINE_TOKEN)) {
    const name = (m[1] ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function lookupInlineFile(filesByName: Map<string, string> | undefined, name: string): string | undefined {
  if (!filesByName) return undefined;
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!norm) return undefined;
  const direct = filesByName.get(norm);
  if (direct && fs.existsSync(direct)) return direct;
  const base = norm.split("/").pop();
  const hit = base ? filesByName.get(base) : undefined;
  return hit && fs.existsSync(hit) ? hit : undefined;
}

function idPrefix(name: string): string {
  const stem = path.basename(name, path.extname(name)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem.slice(0, 24) || "f"}-`;
}

/**
 * Prefix every id in an SVG and every reference to it (href="#id", url(#id)).
 * The XML prolog and doctype are dropped so the markup can sit inside HTML.
 */
export function namespaceSvgIds(svg: string, prefix: string): string {
  let out = svg
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trim();
  const ids = new Set<string>();
  for (const m of out.matchAll(/\bid\s*=\s*(["'])([^"']+)\1/g)) ids.add(m[2]!);
  if (!ids.size) return out;
  out = out.replace(/(\bid\s*=\s*)(["'])([^"']+)\2/g, (whole, lead: string, q: string, id: string) =>
    ids.has(id) ? `${lead}${q}${prefix}${id}${q}` : whole,
  );
  out = out.replace(/((?:xlink:)?href\s*=\s*)(["'])#([^"']+)\2/g, (whole, lead: string, q: string, id: string) =>
    ids.has(id) ? `${lead}${q}#${prefix}${id}${q}` : whole,
  );
  out = out.replace(/url\(\s*(["']?)#([^)"']+)\1\s*\)/g, (whole, q: string, id: string) =>
    ids.has(id) ? `url(${q}#${prefix}${id}${q})` : whole,
  );
  return out;
}

/** True when the token sits where a URL belongs: src="…", href="…", url(…). */
function inUrlPosition(before: string): boolean {
  const tail = before.slice(-48);
  return /(?:\bsrc|\bhref|\bposter|\bdata)\s*=\s*["']\s*$/i.test(tail) || /url\(\s*["']?\s*$/i.test(tail);
}

function expansionFor(abs: string, name: string, asUrl: boolean): string {
  const size = fs.statSync(abs).size;
  if (size > INLINE_MAX_BYTES) {
    throw new Error(`{{inline:${name}}} is ${size} bytes. Place it as an asset instead.`);
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".svg" && asUrl) {
    return `data:image/svg+xml;base64,${fs.readFileSync(abs).toString("base64")}`;
  }
  if (ext === ".svg") return namespaceSvgIds(fs.readFileSync(abs, "utf8"), idPrefix(name));
  if (TEXT_EXT.has(ext)) return fs.readFileSync(abs, "utf8");
  const mime = IMAGE_MIME[ext];
  if (mime) return `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  throw new Error(`{{inline:${name}}} is not a text file or an image. Place it as an asset instead.`);
}

/** Replace every {{inline:name}} with the named file. An unknown name is an error. */
export function expandInlineFiles(content: string, filesByName: Map<string, string> | undefined): string {
  if (!content || !content.includes("{{")) return content;
  const cache = new Map<string, string>();
  return content.replace(INLINE_TOKEN, (_whole, raw: string, offset: number, all: string) => {
    const name = raw.trim();
    // An SVG named inside src="…" or url(…) cannot be markup there. It becomes a data: URI.
    const asUrl = inUrlPosition(all.slice(Math.max(0, offset - 48), offset));
    const key = `${asUrl ? "url" : "text"}|${name.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const abs = lookupInlineFile(filesByName, name);
    if (!abs) throw new Error(`Attached file not found: ${name}`);
    const text = expansionFor(abs, name, asUrl);
    cache.set(key, text);
    return text;
  });
}
