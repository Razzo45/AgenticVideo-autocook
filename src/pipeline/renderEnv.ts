/**
 * Facts about where the brain's files are drawn, told to the brain as they are.
 * The platform does not choose for the model; it says what this worker can do.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

let fontCache: string[] | null = null;

/** Font families fontconfig can find on this machine (what Chromium and SVG drawing use). */
export function installedFontFamilies(): string[] {
  if (fontCache) return fontCache;
  try {
    const out = execFileSync("fc-list", [":", "family"], { encoding: "utf8", timeout: 10_000 });
    const families = new Set<string>();
    for (const line of out.split("\n")) {
      // One family per line, sometimes "Localised,English". Keep the first name.
      const name = line.split(",")[0]?.trim();
      if (name) families.add(name);
    }
    fontCache = [...families].sort((a, b) => a.localeCompare(b));
  } catch {
    fontCache = [];
  }
  return fontCache;
}

/** The installed list as one line. Noto's per-script families are counted, not listed. */
export function installedFontsLine(families = installedFontFamilies()): string {
  if (!families.length) return "";
  const scripts = families.filter((name) => /^Noto (Sans|Serif) .+/.test(name) && !/^Noto (Sans|Serif) (Mono|Display)$/.test(name));
  const named = families.filter((name) => !scripts.includes(name));
  const tail = scripts.length ? `; plus Noto Sans/Serif for ${scripts.length} other scripts` : "";
  return `${named.join(", ")}${tail}`;
}

let officeCache: string | null | undefined;

export function libreOfficeBinary(): string | null {
  if (officeCache !== undefined) return officeCache;
  const candidates = [
    process.env.LIBREOFFICE_BIN,
    process.env.SOFFICE_BIN,
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  ].filter(Boolean) as string[];
  officeCache = candidates.find((bin) => fs.existsSync(bin)) ?? null;
  if (!officeCache) {
    try {
      execFileSync("soffice", ["--version"], { timeout: 20_000, stdio: "ignore" });
      officeCache = "soffice";
    } catch {
      officeCache = null;
    }
  }
  return officeCache;
}

/** Test hook. */
export function resetRenderEnvCache(): void {
  fontCache = null;
  officeCache = undefined;
}
