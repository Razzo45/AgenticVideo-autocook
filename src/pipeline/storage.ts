/**
 * Run-file storage.
 *
 * - local mode (dev): RUNS_DIR is source of truth.
 * - s3 mode (Railway): the bucket is source of truth. Local RUNS_DIR is a
 *   per-run working cache for ffmpeg / generators. Flow:
 *     write local → persist to bucket after each job (keep local while run is active)
 *     web / other workers → ensureLocal* pulls from bucket on demand
 *     when the cook finishes → sanitize staging + clear local cache
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { RUNS_DIR, toPosix } from "./paths";

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return "";
}

function bucketConfigured(): boolean {
  return Boolean(
    envFirst("S3_BUCKET", "STORAGE_S3_BUCKET") &&
      envFirst("S3_ACCESS_KEY_ID", "STORAGE_S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID") &&
      envFirst("S3_SECRET_ACCESS_KEY", "STORAGE_S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
  );
}

let s3: S3Client | null = null;

function s3Client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: envFirst("S3_REGION", "STORAGE_S3_REGION", "AWS_REGION") || "auto",
      endpoint: envFirst("S3_ENDPOINT", "STORAGE_S3_ENDPOINT") || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1" || process.env.STORAGE_S3_FORCE_PATH_STYLE === "1",
      credentials: {
        accessKeyId: envFirst("S3_ACCESS_KEY_ID", "STORAGE_S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
        secretAccessKey: envFirst("S3_SECRET_ACCESS_KEY", "STORAGE_S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
      },
    });
  }
  return s3;
}

function bucket(): string {
  return envFirst("S3_BUCKET", "STORAGE_S3_BUCKET");
}

export function storageMode(): "local" | "s3" {
  return bucketConfigured() ? "s3" : "local";
}

export function localRunPath(runId: string, rel = ""): string {
  return rel ? path.join(RUNS_DIR, runId, rel) : path.join(RUNS_DIR, runId);
}

/** Guess Content-Type for common run artifacts. */
export function guessContentType(relOrName: string): string | undefined {
  const ext = path.extname(relOrName).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".pdf": "application/pdf",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".txt": "text/plain",
  };
  return map[ext];
}

/** Parse absolute path under RUNS_DIR into { runId, rel }. */
export function parseRunAbsPath(absPath: string): { runId: string; rel: string } | null {
  const abs = path.resolve(absPath);
  const root = path.resolve(RUNS_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const rest = abs.slice(root.length).replace(/^[/\\]+/, "");
  if (!rest) return null;
  const parts = rest.split(/[/\\]/);
  const runId = parts[0];
  if (!runId) return null;
  const rel = toPosix(parts.slice(1).join("/"));
  return { runId, rel };
}

/** Write bytes to the working cache and (in s3 mode) upload as canonical copy. */
export async function putRunObject(
  runId: string,
  relPath: string,
  data: Buffer | string,
  contentType?: string,
): Promise<string> {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = localRunPath(runId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  if (storageMode() === "s3") {
    const body = typeof data === "string" ? Buffer.from(data) : data;
    await s3Client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: `runs/${runId}/${rel}`,
        Body: body,
        ContentType: contentType ?? guessContentType(rel),
      }),
    );
  }
  return abs;
}

/**
 * Upload an existing local working-cache file to the bucket (canonical).
 * No-op when storage is local-only or path is outside RUNS_DIR.
 */
export async function persistRunFile(absPath: string): Promise<string> {
  const parsed = parseRunAbsPath(absPath);
  if (!parsed) return absPath;
  const abs = path.resolve(absPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return abs;
  if (storageMode() !== "s3") return abs;
  const st = fs.statSync(abs);
  const body = fs.createReadStream(abs);
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: `runs/${parsed.runId}/${parsed.rel}`,
      Body: body,
      ContentLength: st.size,
      ContentType: guessContentType(parsed.rel),
    }),
  );
  return abs;
}

/** Persist every regular file under a directory (relative to run root). */
export async function persistRunTree(runId: string, relPrefix = ""): Promise<number> {
  const root = localRunPath(runId, relPrefix);
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const walk = async (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".omni_upload" || ent.name === "node_modules") continue;
        await walk(full);
      } else if (ent.isFile()) {
        await persistRunFile(full);
        n += 1;
      }
    }
  };
  if (fs.statSync(root).isFile()) {
    await persistRunFile(root);
    return 1;
  }
  await walk(root);
  return n;
}

/**
 * Wipe the local working cache for a run. Does NOT touch the bucket.
 * Call after a successful persist so Railway disks stay small; next step pulls from S3.
 */
export function clearLocalRunCache(runId: string): boolean {
  const dir = localRunPath(runId);
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    return true;
  } catch (err) {
    console.error(`[storage] clearLocalRunCache ${runId}`, err);
    return false;
  }
}

/** Persist to bucket then drop the local cache (s3 mode only). */
export async function commitRunToBucket(runId: string): Promise<number> {
  const n = await persistRunTree(runId);
  if (storageMode() === "s3") clearLocalRunCache(runId);
  return n;
}

/** Ensure a local file exists (download from bucket if needed). */
export async function ensureLocalRunFile(runId: string, relPath: string): Promise<string> {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = localRunPath(runId, rel);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
  if (storageMode() !== "s3") return abs;
  const out = await s3Client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: `runs/${runId}/${rel}` }),
    { abortSignal: AbortSignal.timeout(120_000) },
  );
  if (!out.Body) throw new Error(`Empty bucket object: runs/${runId}/${rel}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await pipeline(out.Body as Readable, fs.createWriteStream(abs));
  return abs;
}

/** True when the run file is on local disk or in the bucket. Does not download it. */
export async function runFileExists(absPath: string): Promise<boolean> {
  const abs = path.resolve(absPath);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return true;
  const parsed = parseRunAbsPath(abs);
  if (!parsed?.rel || storageMode() !== "s3") return false;
  try {
    await s3Client().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: `runs/${parsed.runId}/${parsed.rel}` }),
      { abortSignal: AbortSignal.timeout(8_000) },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure an absolute run path exists locally (pull from S3 if missing).
 * Returns the abs path; throws if still missing after S3 attempt.
 */
export async function ensureAbsRunFile(absPath: string): Promise<string> {
  const abs = path.resolve(absPath);
  if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
  const parsed = parseRunAbsPath(abs);
  if (!parsed || !parsed.rel) {
    if (fs.existsSync(abs)) return abs;
    throw new Error(`Missing run file: ${absPath}`);
  }
  try {
    await ensureLocalRunFile(parsed.runId, parsed.rel);
  } catch (err) {
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).size <= 0) {
    throw new Error(`Missing run file after bucket fetch: runs/${parsed.runId}/${parsed.rel}`);
  }
  return abs;
}

export async function deleteRunPrefix(runId: string, relPrefix = ""): Promise<number> {
  const prefix = relPrefix.replace(/\\/g, "/").replace(/^\/+/, "");
  let n = 0;
  const root = localRunPath(runId, prefix);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
    n += 1;
  }
  if (storageMode() !== "s3") return n;
  const listPrefix = `runs/${runId}/${prefix}`.replace(/\/+$/, "") + (prefix ? "/" : "");
  let token: string | undefined;
  do {
    const page = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: listPrefix === `runs/${runId}/` ? `runs/${runId}/` : listPrefix,
        ContinuationToken: token,
      }),
    );
    const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    if (keys.length) {
      await s3Client().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
      n += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return n;
}

export async function deleteRunObject(runId: string, relPath: string): Promise<void> {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = localRunPath(runId, rel);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  if (storageMode() === "s3") {
    await s3Client().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: `runs/${runId}/${rel}` }),
    );
  }
}

/** Startup probe — logs mode and optionally verifies bucket reachability. */
export async function logStorageBoot(label: string): Promise<void> {
  const mode = storageMode();
  const b = bucket() || "(none)";
  const endpoint = envFirst("S3_ENDPOINT", "STORAGE_S3_ENDPOINT") || "(default)";
  console.log(`[storage] ${label} mode=${mode} bucket=${b} endpoint=${endpoint} runsDir=${RUNS_DIR}`);
  if (mode !== "s3") return;
  try {
    await s3Client().send(new HeadBucketCommand({ Bucket: bucket() }));
    console.log(`[storage] ${label} bucket reachable`);
  } catch (err) {
    console.error(`[storage] ${label} bucket head failed`, err instanceof Error ? err.message : err);
  }
}
