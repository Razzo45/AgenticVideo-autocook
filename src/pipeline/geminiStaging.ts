/**
 * Gemini Files API staging + URI reuse — ported from GDP gemini.ts mediaPart / stagedFileUri.
 * Content-hash keyed; inline small non-AV; video/audio always staged.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GoogleGenAI, FileState } from "@google/genai";
import { cachedGeminiUriDecision } from "./geminiFileCache";
import { getDb } from "../db";
import { getPgPool, pgQuery, postgresConfigured } from "./pg";
import { withGeminiAdmission } from "./geminiAdmission";

const FILE_TTL_MS = 47 * 60 * 60_000;
const INLINE_LIMIT = 12 * 1024 * 1024;
const PDF_INLINE_LIMIT = 2 * 1024 * 1024;

export type StagedMedia =
  | { kind: "inline"; mime: string; data: string; label: string }
  | { kind: "uri"; mime: string; data: string; label: string; sha256: string; name: string };

const stagingInFlight = new Map<string, Promise<string>>();

function requireKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") throw new Error("GEMINI_API_KEY missing for Files staging");
  return key;
}

function ai(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireKey() });
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function sha256Bytes(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function shouldInlineMedia(mime: string, bytes: number, opts?: { stage?: boolean }): boolean {
  if (opts?.stage) return false;
  if (/^(video|audio)\//.test(mime)) return false;
  if (mime === "application/pdf" && bytes > PDF_INLINE_LIMIT) return false;
  return bytes <= INLINE_LIMIT;
}

export function geminiFileName(uri: string): string {
  return uri.includes("/") ? uri.split("/").slice(-2).join("/") : uri;
}

function ensureSqliteTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS gemini_files (
      sha256 TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gemini_file_uses (
      sha256 TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (sha256, run_id)
    );
  `);
}

async function cacheLookup(digest: string): Promise<{ uri: string; mime: string; size: number; expires_at: string } | null> {
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  if (postgresConfigured()) {
    try {
      const rows = await pgQuery<{ uri: string; mime: string; size: string; expires_at: Date }>(
        `select uri, mime, size, expires_at from app.gemini_files
         where sha256 = $1 and expires_at > $2::timestamptz limit 1`,
        [digest, soon],
      );
      const r = rows[0];
      if (!r) return null;
      return { uri: r.uri, mime: r.mime, size: Number(r.size), expires_at: new Date(r.expires_at).toISOString() };
    } catch {
      /* fall through to sqlite */
    }
  }
  ensureSqliteTables();
  const row = getDb()
    .prepare(`SELECT uri, mime, size, expires_at FROM gemini_files WHERE sha256 = ? AND expires_at > ? LIMIT 1`)
    .get(digest, soon) as { uri: string; mime: string; size: number; expires_at: string } | undefined;
  return row ?? null;
}

async function cacheUpsert(row: {
  sha256: string;
  uri: string;
  mime: string;
  size: number;
  expires_at: string;
}): Promise<void> {
  if (postgresConfigured()) {
    try {
      await pgQuery(
        `insert into app.gemini_files (sha256, uri, mime, size, expires_at)
         values ($1,$2,$3,$4,$5::timestamptz)
         on conflict (sha256) do update set
           uri = excluded.uri, mime = excluded.mime, size = excluded.size, expires_at = excluded.expires_at`,
        [row.sha256, row.uri, row.mime, row.size, row.expires_at],
      );
      return;
    } catch {
      /* sqlite fallback */
    }
  }
  ensureSqliteTables();
  getDb()
    .prepare(
      `INSERT INTO gemini_files (sha256, uri, mime, size, expires_at, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(sha256) DO UPDATE SET
         uri=excluded.uri, mime=excluded.mime, size=excluded.size, expires_at=excluded.expires_at`,
    )
    .run(row.sha256, row.uri, row.mime, row.size, row.expires_at, new Date().toISOString());
}

async function cacheDelete(digest: string): Promise<void> {
  if (postgresConfigured()) {
    try {
      await pgQuery(`delete from app.gemini_files where sha256 = $1`, [digest]);
    } catch {
      /* ignore */
    }
  }
  ensureSqliteTables();
  getDb().prepare(`DELETE FROM gemini_files WHERE sha256 = ?`).run(digest);
}

export async function rememberGeminiUse(digest: string, runId: string): Promise<void> {
  if (!digest || !runId) return;
  if (postgresConfigured()) {
    try {
      await pgQuery(
        `insert into app.gemini_file_uses (sha256, run_id) values ($1,$2) on conflict do nothing`,
        [digest, runId],
      );
      return;
    } catch {
      /* sqlite */
    }
  }
  ensureSqliteTables();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO gemini_file_uses (sha256, run_id, created_at) VALUES (?,?,?)`,
    )
    .run(digest, runId, new Date().toISOString());
}

export async function dropGeminiFile(uri: string): Promise<void> {
  try {
    await ai().files.delete({ name: geminiFileName(uri) });
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
    if (status === 404 || status === 403) return;
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT_FOUND|not found|404/i.test(message)) return;
  }
}

export async function lookupActiveFileUri(digest: string): Promise<string | null> {
  const cached = await cacheLookup(digest);
  if (!cached) return null;
  try {
    const file = await ai().files.get({ name: geminiFileName(cached.uri) });
    const decision = cachedGeminiUriDecision({
      getFailed: false,
      state: file.state != null ? String(file.state) : null,
      uri: file.uri,
    });
    if (decision === "use") return file.uri ?? cached.uri;
    if (decision === "keep") return cached.uri;
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
    if (cachedGeminiUriDecision({ getFailed: true, status }) === "keep") return cached.uri;
  }
  await dropGeminiFile(cached.uri).catch(() => undefined);
  await cacheDelete(digest);
  return null;
}

async function stagedFileUriOnce(input: {
  bytes: Buffer;
  mime: string;
  sha256: string;
  name: string;
  onStatus?: (m: string) => void;
}): Promise<string> {
  const live = await lookupActiveFileUri(input.sha256);
  if (live) {
    input.onStatus?.(`Reusing staged Gemini file for ${input.name}…`);
    return live;
  }
  input.onStatus?.(`Staging ${input.name} to Gemini Files (${Math.round(input.bytes.length / 1024)} KB)…`);
  const uploaded = await withGeminiAdmission("files", async () => {
    const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mime });
    return ai().files.upload({
      file: blob,
      config: { mimeType: input.mime, displayName: input.name.slice(0, 120) },
    });
  });
  if (!uploaded.name) throw new Error(`Gemini upload returned no name for ${input.name}`);
  let file = uploaded;
  const deadline = Date.now() + 20 * 60_000;
  while (file.state === FileState.PROCESSING && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      file = await ai().files.get({ name: file.name! });
    } catch {
      /* keep polling */
    }
  }
  if (file.state !== FileState.ACTIVE || !file.uri) {
    throw new Error(`Gemini could not process ${input.name} (${file.state ?? "unknown"})`);
  }
  const expiresAt = new Date(Date.now() + FILE_TTL_MS).toISOString();
  await cacheUpsert({
    sha256: input.sha256,
    uri: file.uri,
    mime: input.mime,
    size: input.bytes.length,
    expires_at: expiresAt,
  });
  return file.uri;
}

export async function stagedFileUri(input: {
  bytes: Buffer;
  mime: string;
  sha256: string;
  name: string;
  onStatus?: (m: string) => void;
}): Promise<string> {
  const pending = stagingInFlight.get(input.sha256);
  if (pending) return pending;
  const work = stagedFileUriOnce(input);
  stagingInFlight.set(input.sha256, work);
  try {
    return await work;
  } finally {
    if (stagingInFlight.get(input.sha256) === work) stagingInFlight.delete(input.sha256);
  }
}

/** Stage a local plate/still for Omni — reuses URI by sha256 when possible. */
export async function stageLocalPath(
  filePath: string,
  mime: string,
  opts?: { forceStage?: boolean; runId?: string; onStatus?: (m: string) => void },
): Promise<StagedMedia> {
  const buf = fs.readFileSync(filePath);
  const digest = sha256Bytes(buf);
  const label = path.basename(filePath);
  if (!opts?.forceStage && shouldInlineMedia(mime, buf.length)) {
    return { kind: "inline", mime, data: buf.toString("base64"), label };
  }
  const uri = await stagedFileUri({
    bytes: buf,
    mime,
    sha256: digest,
    name: label,
    onStatus: opts?.onStatus,
  });
  if (opts?.runId) await rememberGeminiUse(digest, opts.runId);
  return { kind: "uri", mime, data: uri, label, sha256: digest, name: geminiFileName(uri) };
}

/** Reaper: drop expired / unused staged handles. */
export async function reapGeminiFiles(): Promise<{ culled: number }> {
  ensureSqliteTables();
  const now = new Date().toISOString();
  let culled = 0;
  const expired = getDb()
    .prepare(`SELECT sha256, uri FROM gemini_files WHERE expires_at <= ?`)
    .all(now) as Array<{ sha256: string; uri: string }>;
  for (const row of expired) {
    await dropGeminiFile(row.uri).catch(() => undefined);
    getDb().prepare(`DELETE FROM gemini_file_uses WHERE sha256 = ?`).run(row.sha256);
    getDb().prepare(`DELETE FROM gemini_files WHERE sha256 = ?`).run(row.sha256);
    culled += 1;
  }
  if (postgresConfigured() && getPgPool()) {
    try {
      const rows = await pgQuery<{ sha256: string; uri: string }>(
        `select sha256, uri from app.gemini_files where expires_at <= now()`,
      );
      for (const row of rows) {
        await dropGeminiFile(row.uri).catch(() => undefined);
        await pgQuery(`delete from app.gemini_file_uses where sha256 = $1`, [row.sha256]);
        await pgQuery(`delete from app.gemini_files where sha256 = $1`, [row.sha256]);
        culled += 1;
      }
    } catch {
      /* optional */
    }
  }
  return { culled };
}
