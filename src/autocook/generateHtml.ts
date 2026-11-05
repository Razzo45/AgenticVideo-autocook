/**
 * HTML cook — Argon owns file contents; platform writes verbatim.
 * Materializes Argon media tools (image/video/SVG), rewrites {{asset:id}},
 * optional Chromium screenshot, zip when multi-file.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import type { HtmlPlan } from "../pipeline/schemaDocs";
import {
  materializePlanAssets,
  rewriteAssetPlaceholders,
  type MediaToolContext,
  type StagedMedia,
} from "./argonMediaTools";

const execFileAsync = promisify(execFile);

export type GenerateHtmlResult = {
  entryPath: string;
  written: string[];
  bundleDir: string;
  zipPath?: string;
  screenshotPath?: string;
};

function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("..")) throw new Error(`Unsafe path in HTML plan: ${rel}`);
  return norm;
}

function chromeCandidates(): string[] {
  return [
    process.env.CHROMIUM_BIN,
    process.env.CHROME_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
}

async function screenshotEntry(htmlPath: string, outPng: string): Promise<boolean> {
  const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
  for (const bin of chromeCandidates()) {
    if ((bin.includes("\\") || bin.includes("/")) && !fs.existsSync(bin)) continue;
    try {
      await execFileAsync(
        bin,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          `--screenshot=${outPng}`,
          "--window-size=1280,720",
          fileUrl,
        ],
        { timeout: 60_000, windowsHide: true },
      );
      if (fs.existsSync(outPng) && fs.statSync(outPng).size > 100) return true;
    } catch {
      /* try next browser */
    }
  }
  return false;
}

async function zipBundle(bundleDir: string, written: string[], outZip: string): Promise<void> {
  const zip = new JSZip();
  for (const abs of written) {
    const rel = path.relative(bundleDir, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue;
    zip.file(rel, fs.readFileSync(abs));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outZip, buf);
}

function loadStagedRegistry(outDir: string): Map<string, StagedMedia> {
  const map = new Map<string, StagedMedia>();
  const stagingDir = path.join(outDir, "argon_media");
  const registryPath = path.join(stagingDir, "staged.json");
  if (!fs.existsSync(registryPath)) return map;
  try {
    const rows = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Array<{
      id: string;
      format: StagedMedia["format"];
      filename: string;
      absPath: string;
      embed: "path" | "data_uri";
      mime: string;
    }>;
    for (const r of rows) {
      if (!r.absPath || !fs.existsSync(r.absPath)) continue;
      let dataUri: string | undefined;
      if (r.format === "png" || r.format === "svg") {
        const buf = fs.readFileSync(r.absPath);
        const b64 = buf.toString("base64");
        dataUri =
          r.format === "svg"
            ? `data:image/svg+xml;base64,${b64}`
            : `data:image/png;base64,${b64}`;
      }
      map.set(r.id, { ...r, dataUri });
    }
  } catch {
    /* ignore corrupt registry */
  }
  return map;
}

export async function generateHtml(opts: {
  plan: HtmlPlan;
  outDir: string;
  referenceImagePaths?: string[];
  onStatus?: (msg: string) => void;
}): Promise<GenerateHtmlResult> {
  const bundleDir = path.join(opts.outDir, "site");
  fs.mkdirSync(bundleDir, { recursive: true });
  const written: string[] = [];

  const ctx: MediaToolContext = {
    stagingDir: path.join(opts.outDir, "argon_media"),
    staged: loadStagedRegistry(opts.outDir),
    referenceImagePaths: opts.referenceImagePaths,
    onStatus: opts.onStatus,
  };

  if (opts.plan.assets?.length) {
    opts.onStatus?.(`Materializing ${opts.plan.assets.length} Argon media asset(s)…`);
    await materializePlanAssets(opts.plan.assets, ctx);
  }

  // Copy staged media into the site bundle (path embeds)
  for (const m of ctx.staged.values()) {
    if (m.embed === "data_uri" && (m.format === "png" || m.format === "svg")) continue;
    const rel = safeRel(m.filename);
    const abs = path.join(bundleDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (path.resolve(m.absPath) !== path.resolve(abs)) {
      fs.copyFileSync(m.absPath, abs);
    }
    written.push(abs);
  }

  opts.onStatus?.(`Writing ${opts.plan.files.length} HTML bundle file(s)…`);
  for (const file of opts.plan.files) {
    const rel = safeRel(file.path);
    const abs = path.join(bundleDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = rewriteAssetPlaceholders(file.content, ctx.staged.values());
    fs.writeFileSync(abs, content, "utf8");
    written.push(abs);
  }

  const entryRel = safeRel(opts.plan.entry);
  const entryPath = path.join(bundleDir, entryRel);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`HTML plan entry missing on disk: ${opts.plan.entry}`);
  }

  let zipPath: string | undefined;
  if (written.length > 1) {
    zipPath = path.join(opts.outDir, "site.zip");
    opts.onStatus?.("Zipping multi-file HTML bundle…");
    await zipBundle(bundleDir, written, zipPath);
  }

  let screenshotPath: string | undefined;
  if (opts.plan.screenshot) {
    const outPng = path.join(opts.outDir, "qa_screenshot.png");
    opts.onStatus?.("Capturing Chromium QA screenshot…");
    const ok = await screenshotEntry(entryPath, outPng);
    if (ok) {
      screenshotPath = outPng;
    } else {
      opts.onStatus?.("QA screenshot skipped (Chrome/Edge not available).");
    }
  }

  fs.writeFileSync(path.join(opts.outDir, "html_plan.json"), JSON.stringify(opts.plan, null, 2));
  return { entryPath, written, bundleDir, zipPath, screenshotPath };
}
