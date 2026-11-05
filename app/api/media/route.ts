import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { ROOT, RUNS_DIR } from "@/src/pipeline/paths";
import { ensureAbsRunFile, parseRunAbsPath } from "@/src/pipeline/storage";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Stream media with Range support — never buffer whole MP4s into memory (was crashing Next). */
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path");
  if (!rel) return NextResponse.json({ error: "path required" }, { status: 400 });
  const decoded = decodeURIComponent(rel);
  // Accept both repo-relative (runs/…) and absolute under RUNS_DIR.
  const abs = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(ROOT, decoded);
  const allowed = [path.resolve(RUNS_DIR), path.resolve(ROOT, "dataset")];
  const okPath = allowed.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!okPath) return NextResponse.json({ error: "path not allowed" }, { status: 403 });

  // Pull from shared bucket when this container's disk is empty (web vs worker).
  if (parseRunAbsPath(abs)) {
    try {
      await ensureAbsRunFile(abs);
    } catch {
      /* fall through to local 404 */
    }
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!st.isFile()) return NextResponse.json({ error: "not found" }, { status: 404 });

  const ext = path.extname(abs).toLowerCase();
  const contentType = TYPES[ext] ?? "application/octet-stream";
  const size = st.size;
  const range = req.headers.get("range");
  const asDownload = req.nextUrl.searchParams.get("download") === "1";
  const filename = path.basename(abs).replace(/[^\w.\-()+ ]+/g, "_") || "download";
  const disposition = asDownload
    ? `attachment; filename="${filename}"`
    : `inline; filename="${filename}"`;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!m) return new NextResponse("Malformed Range", { status: 416 });
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
      return new NextResponse("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const clippedEnd = Math.min(end, size - 1);
    const chunkSize = clippedEnd - start + 1;
    const nodeStream = fs.createReadStream(abs, { start, end: clippedEnd });
    return new NextResponse(Readable.toWeb(nodeStream) as unknown as BodyInit, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${clippedEnd}/${size}`,
        "Content-Disposition": disposition,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
      },
    });
  }

  const nodeStream = fs.createReadStream(abs);
  return new NextResponse(Readable.toWeb(nodeStream) as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Content-Disposition": disposition,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
    },
  });
}
