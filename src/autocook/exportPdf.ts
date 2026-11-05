/**
 * PDF export — plan-owned post only (HTML or PPTX → PDF).
 * Tries LibreOffice, then Edge/Chrome headless print-to-PDF for HTML.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function whichCandidates(names: string[]): string[] {
  const roots = [
    process.env.LIBREOFFICE_BIN,
    process.env.SOFFICE_BIN,
    "soffice",
    "soffice.exe",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
  ].filter(Boolean) as string[];
  return [...names, ...roots];
}

async function tryExec(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 180_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function libreOfficeToPdf(input: string, outDir: string): Promise<string | null> {
  const bins = whichCandidates([]);
  for (const bin of bins) {
    if (bin.includes("\\") || bin.includes("/")) {
      if (!fs.existsSync(bin)) continue;
    }
    const ok = await tryExec(bin, [
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      "--convert-to",
      "pdf",
      "--outdir",
      outDir,
      input,
    ]);
    if (!ok) continue;
    const base = path.basename(input, path.extname(input)) + ".pdf";
    const out = path.join(outDir, base);
    if (fs.existsSync(out)) return out;
  }
  return null;
}

async function chromiumHtmlToPdf(htmlPath: string, outPdf: string): Promise<boolean> {
  const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
  const chromes = [
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

  for (const bin of chromes) {
    if ((bin.includes("\\") || bin.includes("/")) && !fs.existsSync(bin)) continue;
    const ok = await tryExec(bin, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-pdf-header-footer",
      `--print-to-pdf=${outPdf}`,
      fileUrl,
    ]);
    if (ok && fs.existsSync(outPdf) && fs.statSync(outPdf).size > 100) return true;
  }
  return false;
}

export type ExportPdfResult = {
  pdfPath: string;
  method: "libreoffice" | "chromium" | "copied-placeholder";
};

/**
 * Export PDF from an existing HTML entry or PPTX path as Argon requested.
 */
export async function exportPdf(opts: {
  sourcePath: string;
  outDir: string;
  /** Preferred output filename (default master.pdf). */
  outName?: string;
  onStatus?: (msg: string) => void;
}): Promise<ExportPdfResult> {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const outName = opts.outName ?? "master.pdf";
  const outPdf = path.join(opts.outDir, outName);
  const ext = path.extname(opts.sourcePath).toLowerCase();

  opts.onStatus?.(`Exporting PDF from ${path.basename(opts.sourcePath)}…`);

  if (ext === ".html" || ext === ".htm") {
    const viaLo = await libreOfficeToPdf(opts.sourcePath, opts.outDir);
    if (viaLo) {
      if (path.resolve(viaLo) !== path.resolve(outPdf)) fs.renameSync(viaLo, outPdf);
      return { pdfPath: outPdf, method: "libreoffice" };
    }
    if (await chromiumHtmlToPdf(opts.sourcePath, outPdf)) {
      return { pdfPath: outPdf, method: "chromium" };
    }
  } else if (ext === ".pptx" || ext === ".ppt") {
    const viaLo = await libreOfficeToPdf(opts.sourcePath, opts.outDir);
    if (viaLo) {
      if (path.resolve(viaLo) !== path.resolve(outPdf)) fs.renameSync(viaLo, outPdf);
      return { pdfPath: outPdf, method: "libreoffice" };
    }
  }

  // Last resort: still produce a file so the cook completes; mark method for operators.
  const note = `PDF export tools unavailable (LibreOffice / Chrome / Edge). Source: ${opts.sourcePath}\n`;
  fs.writeFileSync(outPdf.replace(/\.pdf$/i, ".pdf.txt"), note, "utf8");
  throw new Error(
    "PDF export failed: install LibreOffice (soffice) or Chrome/Edge for HTML print-to-PDF.",
  );
}
