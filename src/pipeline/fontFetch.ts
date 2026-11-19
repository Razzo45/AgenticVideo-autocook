/**
 * The font families a file names, drawn in those families where they can be had.
 *
 * Files the worker draws itself (a PDF printed from HTML, a PNG drawn from SVG) used to
 * fall back silently to an installed face whenever the brain named another family. Now:
 *  1. The families the markup names are read from it (font-family, the font shorthand,
 *     SVG font-family attributes). Families the markup defines with @font-face are its own.
 *  2. A family not installed here is fetched by name from the Google Fonts collection
 *     (open licences: OFL, Apache, UFL), cached on the worker, and made visible to the
 *     renderers through a fontconfig file. The markup is not changed.
 *  3. A family that cannot be had (commercial faces such as Helvetica or Futura) is drawn
 *     in the face fontconfig substitutes, and that substitution is recorded on the file.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** FONT_FETCH=0 turns fetching off (substitutions are still recorded). */
export function fontFetchEnabled(): boolean {
  const raw = (process.env.FONT_FETCH ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

const SOURCE_BASE = () =>
  (process.env.FONT_SOURCE_BASE?.trim() || "https://raw.githubusercontent.com/google/fonts/main").replace(/\/+$/, "");
const LICENCE_DIRS = ["ofl", "apache", "ufl"];
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FONT_BYTES = 40 * 1024 * 1024;

export function fontCacheDir(): string {
  return process.env.FONT_CACHE_DIR?.trim() || path.join(os.tmpdir(), "autocook-fonts");
}

/**
 * A fontconfig file: the system fonts plus the fetched ones. Given to Chromium and to the
 * SVG drawing process through FONTCONFIG_FILE, so a fetched family is found by its name.
 */
export function fontconfigFile(): string {
  const root = fontCacheDir();
  const files = path.join(root, "files");
  const conf = path.join(root, "fonts.conf");
  if (!fs.existsSync(conf)) {
    fs.mkdirSync(files, { recursive: true });
    fs.mkdirSync(path.join(root, "cache"), { recursive: true });
    fs.writeFileSync(
      conf,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <cachedir>${path.join(root, "cache")}</cachedir>
  <dir>${files}</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
`,
    );
  }
  return conf;
}

/** Environment for a renderer child process that should see fetched fonts. */
export function rendererEnv(): NodeJS.ProcessEnv {
  try {
    return { ...process.env, FONTCONFIG_FILE: fontconfigFile() };
  } catch {
    return { ...process.env };
  }
}

const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert",
  "revert-layer", "-apple-system", "blinkmacsystemfont", "default",
]);

function familyList(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "").replace(/\s*!important$/i, "").trim();
    if (!name || /^var\(/i.test(name) || /[(){}<>]/.test(name)) continue;
    if (GENERIC.has(name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
}

/** Cut a CSS value at a quote that closes the surrounding attribute. */
function cssValue(raw: string): string {
  const doubles = (raw.match(/"/g) ?? []).length;
  return doubles % 2 === 1 ? raw.slice(0, raw.indexOf('"')) : raw;
}

const SIZE_TOKEN = /^(?:[\d.]+(?:px|pt|em|rem|%|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pc|q)|0|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\/\S+)?$/i;

/**
 * The family list in a font shorthand: everything after the size (and line height).
 * "700 48px/1.1 'Playfair Display', serif" -> "'Playfair Display', serif".
 */
export function shorthandFamilies(value: string): string | null {
  const tokens = [...value.matchAll(/"[^"]*"|'[^']*'|[^\s]+/g)].map((m) => ({ text: m[0], at: m.index! }));
  let sizeAt = -1;
  for (let i = 0; i < tokens.length; i++) if (SIZE_TOKEN.test(tokens[i]!.text)) sizeAt = i;
  if (sizeAt < 0) return null;
  let start = sizeAt + 1;
  if (tokens[start]?.text === "/") start += 2;
  else if (tokens[start]?.text.startsWith("/")) start += 1;
  const rest = tokens[start] ? value.slice(tokens[start]!.at).trim() : "";
  return rest || null;
}

/** Families a piece of HTML, CSS or SVG names, minus those it defines with @font-face. */
export function requestedFamilies(text: string): string[] {
  const found = new Map<string, string>();
  const add = (name: string) => {
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, name);
  };
  const defined = new Set<string>();
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const fam = m[1]!.match(/font-family\s*:\s*([^;}]+)/i);
    if (fam) for (const name of familyList(fam[1]!)) defined.add(name.toLowerCase());
  }
  for (const m of text.matchAll(/font-family\s*:\s*([^;{}<>\n]+)/gi)) {
    for (const name of familyList(cssValue(m[1]!))) add(name);
  }
  for (const m of text.matchAll(/(?:^|[\s;{"'])font\s*:\s*([^;{}<>\n]+)/gi)) {
    const families = shorthandFamilies(cssValue(m[1]!));
    if (families) for (const name of familyList(families)) add(name);
  }
  for (const m of text.matchAll(/font-family\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const name of familyList((m[1] ?? m[2])!)) add(name);
  }
  return [...found.values()].filter((name) => !defined.has(name.toLowerCase()));
}

function fontconfigAvailable(): boolean {
  try {
    execFileSync("fc-list", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Is this exact family installed or already fetched? */
export async function familyAvailable(family: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("fc-list", [`${family.replace(/[:\\-]/g, "\\$&")}`, "family"], {
      env: rendererEnv(),
      timeout: 20_000,
    });
    const want = family.toLowerCase();
    return stdout
      .split("\n")
      .some((line) => line.split(",").some((name) => name.trim().toLowerCase() === want));
  } catch {
    return false;
  }
}

async function fetchBytes(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FONT_BYTES) throw new Error(`${url} is ${length} bytes`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FONT_BYTES) throw new Error(`${url} is ${buf.length} bytes`);
  return buf;
}

/** Directory name the collection uses for a family: lowercase letters and digits. */
export function collectionDir(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Every font file listed for this exact family in the collection's METADATA.pb, or null. */
export function metadataFiles(metadata: string, family: string): string[] | null {
  const name = metadata.match(/^name:\s*"([^"]+)"/m)?.[1];
  if (!name || name.toLowerCase() !== family.toLowerCase()) return null;
  const files = [...metadata.matchAll(/^\s*filename:\s*"([^"]+)"/gm)].map((m) => m[1]!);
  const safe = files.filter((file) => /^[\w.\-\[\],]+\.(ttf|otf)$/i.test(file));
  return safe.length ? safe : null;
}

const missing = new Set<string>();
const inFlight = new Map<string, Promise<boolean>>();

/** Fetch one family into the cache. True when its files are on disk. */
export async function fetchFamily(family: string): Promise<boolean> {
  const dir = collectionDir(family);
  if (!dir || missing.has(dir)) return false;
  const target = path.join(path.dirname(fontconfigFile()), "files", dir);
  if (fs.existsSync(path.join(target, ".complete"))) return true;
  const pending = inFlight.get(dir);
  if (pending) return pending;
  const work = (async () => {
    for (const licence of LICENCE_DIRS) {
      const base = `${SOURCE_BASE()}/${licence}/${dir}`;
      const meta = await fetchBytes(`${base}/METADATA.pb`);
      if (!meta) continue;
      const files = metadataFiles(meta.toString("utf8"), family);
      if (!files) continue;
      const part = `${target}.part-${process.pid}`;
      fs.rmSync(part, { recursive: true, force: true });
      fs.mkdirSync(part, { recursive: true });
      for (const file of files) {
        const bytes = await fetchBytes(`${base}/${encodeURIComponent(file)}`);
        if (!bytes) throw new Error(`${family}: ${file} is listed but missing`);
        fs.writeFileSync(path.join(part, file), bytes);
      }
      fs.writeFileSync(path.join(part, ".complete"), `${licence}\n`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(part, target);
      // fontconfig trusts a directory's cache while its mtime (in seconds) is unchanged, so a
      // font added within the same second as the last scan would stay invisible. The system
      // fontconfig and the one bundled with sharp keep separate cache versions, so rebuilding
      // with fc-cache is not enough: drop the caches for the fetched-font folder instead.
      const cacheDir = path.join(path.dirname(fontconfigFile()), "cache");
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      console.log(`[fonts] fetched ${family} (${licence}, ${files.length} file(s))`);
      return true;
    }
    missing.add(dir);
    return false;
  })();
  inFlight.set(dir, work);
  try {
    return await work;
  } catch (err) {
    console.warn(`[fonts] ${family} could not be fetched:`, err instanceof Error ? err.message : err);
    return false;
  } finally {
    inFlight.delete(dir);
  }
}

export type FontReport = {
  /** Families fetched for this file. */
  fetched: string[];
  /** Families that could not be had. */
  substituted: string[];
};

/**
 * Make every family the markup names available to the renderers, where possible.
 * Without fontconfig (a dev machine on Windows) nothing is checked and nothing is reported.
 */
export async function prepareFonts(texts: string[]): Promise<FontReport> {
  const report: FontReport = { fetched: [], substituted: [] };
  if (!fontconfigAvailable()) return report;
  const families = new Map<string, string>();
  for (const text of texts) for (const name of requestedFamilies(text)) families.set(name.toLowerCase(), name);
  for (const family of families.values()) {
    if (await familyAvailable(family)) continue;
    if (fontFetchEnabled() && (await fetchFamily(family)) && (await familyAvailable(family))) {
      report.fetched.push(family);
      continue;
    }
    report.substituted.push(family);
  }
  return report;
}

/** The note for a file whose named families could not all be drawn. */
export function substitutionNote(report: FontReport, renderer: string): string | null {
  if (!report.substituted.length) return null;
  const names = report.substituted.join(", ");
  const one = report.substituted.length === 1;
  return `${renderer} did not have ${names}: ${one ? "it is" : "they are"} not installed on the worker and could not be fetched from the Google Fonts collection. That text was drawn in the next family the file lists, or the renderer's default where it lists none.`;
}

/** Test hook. */
export function resetFontFetchState(): void {
  missing.clear();
  inFlight.clear();
}
