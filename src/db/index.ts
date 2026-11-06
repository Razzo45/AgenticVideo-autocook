import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, RUNS_DIR } from "../pipeline/paths";
import { postgresConfigured } from "../pipeline/pg";
import {
  classifyCookJob,
  HEAVY_RUNNING_MAX,
  HELPER_RUNNING_MAX,
  LANE_DEFAULT,
  LANE_HELPER,
} from "../pipeline/jobLanes";
import type { AssetRow, JobRow, ReviewRow, RunRow, VariantRow } from "./types";
import * as pg from "./pgBackend";

export type { AssetRow, JobRow, ReviewRow, RunRow, VariantRow } from "./types";

let db: DatabaseSync | null = null;

function usePg(): boolean {
  return postgresConfigured();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  // Worker + Next share this file; longer busy wait cuts "database is locked" deaths under poll load.
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      category TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      target_duration REAL NOT NULL,
      initial_prompt TEXT NOT NULL,
      script_model TEXT NOT NULL,
      keyframe_model TEXT NOT NULL,
      video_model TEXT NOT NULL,
      current_shot_index INTEGER NOT NULL DEFAULT 0,
      rework_round INTEGER NOT NULL DEFAULT 0,
      gate TEXT,
      revise_comment TEXT,
      script_json TEXT,
      error TEXT,
      counted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS variants (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      shot_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      variant_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model_name TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      probe_json TEXT,
      uniq_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      uniq_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      shot_index INTEGER,
      role TEXT NOT NULL,
      path TEXT NOT NULL,
      parent_uniq_id TEXT,
      meta_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      heavy INTEGER NOT NULL DEFAULT 0,
      archive INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS reviews (
      run_id TEXT PRIMARY KEY,
      gate TEXT NOT NULL,
      checklist_json TEXT,
      aesthetic_score REAL,
      consistency_score REAL,
      use_xfade INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS cook_requests (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (request_id, user_id),
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS cook_tasks (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      cooks_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (request_id, user_id)
    );
  `);
  migrateRuns(db);
  migrateJobs(db);
  migrateCookRequests(db);
  return db;
}

function migrateRuns(database: DatabaseSync): void {
  const cols = database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "input_assets_json")) {
    database.exec("ALTER TABLE runs ADD COLUMN input_assets_json TEXT");
  }
  if (!cols.some((c) => c.name === "pipeline_mode")) {
    database.exec("ALTER TABLE runs ADD COLUMN pipeline_mode TEXT NOT NULL DEFAULT 'agentic'");
  }
  if (!cols.some((c) => c.name === "operator_script")) {
    database.exec("ALTER TABLE runs ADD COLUMN operator_script TEXT");
  }
  if (!cols.some((c) => c.name === "output_resolution")) {
    database.exec("ALTER TABLE runs ADD COLUMN output_resolution TEXT NOT NULL DEFAULT '1080p'");
  }
  if (!cols.some((c) => c.name === "auto_options_json")) {
    database.exec("ALTER TABLE runs ADD COLUMN auto_options_json TEXT");
  }
  if (!cols.some((c) => c.name === "user_id")) {
    database.exec("ALTER TABLE runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-dev'");
  }
  if (!cols.some((c) => c.name === "tenant_id")) {
    database.exec("ALTER TABLE runs ADD COLUMN tenant_id TEXT");
  }
  if (!cols.some((c) => c.name === "created_by_kind")) {
    database.exec("ALTER TABLE runs ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'dev'");
  }
}

function migrateCookRequests(database: DatabaseSync): void {
  const cols = database.prepare("PRAGMA table_info(cook_requests)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "user_id")) {
    database.exec("ALTER TABLE cook_requests ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
  }
}

function migrateJobs(database: DatabaseSync): void {
  const cols = database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "weight")) {
    database.exec(`ALTER TABLE jobs ADD COLUMN weight INTEGER NOT NULL DEFAULT ${LANE_DEFAULT}`);
  }
  const addedHeavy = !cols.some((c) => c.name === "heavy");
  if (addedHeavy) {
    database.exec("ALTER TABLE jobs ADD COLUMN heavy INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "archive")) {
    database.exec("ALTER TABLE jobs ADD COLUMN archive INTEGER NOT NULL DEFAULT 0");
  }
  // One-shot: remap pre-GDP numeric weights (10/20/…/100) into lane 0–4 + heavy.
  if (addedHeavy) {
    database.exec(`
      UPDATE jobs SET
        heavy = CASE WHEN weight >= 50 THEN 1 ELSE heavy END,
        weight = CASE
          WHEN weight <= 4 THEN weight
          WHEN weight <= 15 THEN 0
          WHEN weight <= 25 THEN 1
          WHEN weight <= 35 THEN 1
          WHEN weight <= 45 THEN 2
          WHEN weight <= 60 THEN 3
          ELSE 1
        END
      WHERE weight > 4
    `);
  }
}

export async function insertRun(row: Omit<RunRow, "created_at" | "updated_at">): Promise<RunRow> {
  if (usePg()) return pg.pgInsertRun(row);
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO runs (
        id, session_id, status, category, aspect_ratio, target_duration, initial_prompt,
        script_model, keyframe_model, video_model, current_shot_index, rework_round, gate,
        revise_comment, script_json, input_assets_json, pipeline_mode, operator_script,
        output_resolution, auto_options_json, error, counted, user_id, tenant_id, created_by_kind,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.session_id,
      row.status,
      row.category,
      row.aspect_ratio,
      row.target_duration,
      row.initial_prompt,
      row.script_model,
      row.keyframe_model,
      row.video_model,
      row.current_shot_index,
      row.rework_round,
      row.gate,
      row.revise_comment,
      row.script_json,
      row.input_assets_json ?? null,
      row.pipeline_mode ?? "agentic",
      row.operator_script ?? null,
      row.output_resolution ?? "1080p",
      row.auto_options_json ?? null,
      row.error,
      row.counted,
      row.user_id || "local-dev",
      row.tenant_id ?? null,
      row.created_by_kind || "dev",
      ts,
      ts,
    );
  return (await getRun(row.id))!;
}

export async function getRun(id: string): Promise<RunRow | undefined> {
  if (usePg()) return pg.pgGetRun(id);
  return getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

export async function listRuns(userId?: string): Promise<RunRow[]> {
  if (usePg()) return pg.pgListRuns(userId);
  if (userId) {
    return getDb()
      .prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as RunRow[];
  }
  return getDb().prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunRow[];
}

/**
 * Home / poll payloads — drop multi-MB script_json / operator scripts / input manifests.
 * Keeps a tiny script stub so liveStatus can still report scene N/M.
 */
export async function listRunsForApi(userId?: string): Promise<RunRow[]> {
  const runs = await listRuns(userId);
  return runs.map((run) => ({
    ...run,
    initial_prompt: run.initial_prompt.length > 280 ? `${run.initial_prompt.slice(0, 280)}…` : run.initial_prompt,
    operator_script: null,
    input_assets_json: null,
    script_json: summarizeScriptJsonForList(run.script_json),
  }));
}

function summarizeScriptJsonForList(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as { shots?: unknown[] };
    const n = Array.isArray(parsed.shots) ? parsed.shots.length : 0;
    return JSON.stringify({ shots: Array.from({ length: n }, () => ({})) });
  } catch {
    return null;
  }
}

/** Status histogram for PoC ticker — avoids loading every run row every few seconds. */
export async function countRunsByStatus(userId?: string): Promise<Record<string, number>> {
  if (usePg()) return pg.pgCountRunsByStatus(userId);
  const rows = userId
    ? (getDb()
        .prepare("SELECT status, COUNT(*) AS n FROM runs WHERE user_id = ? GROUP BY status")
        .all(userId) as Array<{ status: string; n: number }>)
    : (getDb()
        .prepare("SELECT status, COUNT(*) AS n FROM runs GROUP BY status")
        .all() as Array<{ status: string; n: number }>);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function setRunInputAssets(id: string, inputAssetsJson: string): Promise<void> {
  if (usePg()) return pg.pgSetRunInputAssets(id, inputAssetsJson);
  getDb()
    .prepare("UPDATE runs SET input_assets_json=?, updated_at=? WHERE id=?")
    .run(inputAssetsJson, nowIso(), id);
}

export async function updateRun(id: string, patch: Partial<RunRow>): Promise<void> {
  if (usePg()) return pg.pgUpdateRun(id, patch);
  const current = await getRun(id);
  if (!current) throw new Error(`Unknown run ${id}`);
  const next = { ...current, ...patch, updated_at: nowIso() };
  getDb()
    .prepare(
      `UPDATE runs SET
        status=?, current_shot_index=?, rework_round=?, gate=?, revise_comment=?,
        script_json=?, error=?, counted=?, script_model=?, keyframe_model=?, video_model=?, updated_at=?
      WHERE id=?`,
    )
    .run(
      next.status,
      next.current_shot_index,
      next.rework_round,
      next.gate,
      next.revise_comment,
      next.script_json,
      next.error,
      next.counted,
      next.script_model,
      next.keyframe_model,
      next.video_model,
      next.updated_at,
      id,
    );
}

export async function touchRun(id: string): Promise<void> {
  if (usePg()) return pg.pgTouchRun(id);
  getDb().prepare("UPDATE runs SET updated_at=? WHERE id=?").run(nowIso(), id);
}

/** GDP-style idempotent cook: same requestId+userId returns the existing run. */
export async function findRunByRequestId(
  requestId: string,
  userId: string,
): Promise<RunRow | undefined> {
  if (usePg()) return pg.pgFindRunByRequestId(requestId, userId);
  const id = requestId.trim();
  if (!id || !userId) return undefined;
  const row = getDb()
    .prepare("SELECT run_id FROM cook_requests WHERE request_id = ? AND user_id = ? LIMIT 1")
    .get(id, userId) as { run_id: string } | undefined;
  return row ? getRun(row.run_id) : undefined;
}

export async function rememberCookRequest(
  requestId: string,
  runId: string,
  userId: string,
): Promise<void> {
  if (usePg()) return pg.pgRememberCookRequest(requestId, runId, userId);
  const id = requestId.trim();
  if (!id || !userId) return;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO cook_requests (request_id, user_id, run_id, created_at) VALUES (?,?,?,?)`,
    )
    .run(id, userId, runId, nowIso());
}

export type CookTaskItem = {
  kind: string;
  label: string;
  brief: string;
  runId: string;
  requestId: string;
};

/** Fan-out manifest for one operator task. Null when this request was a single cook. */
export async function findCookTask(
  requestId: string,
  userId: string,
): Promise<CookTaskItem[] | undefined> {
  if (usePg()) return pg.pgFindCookTask(requestId, userId);
  const id = requestId.trim();
  if (!id || !userId) return undefined;
  const row = getDb()
    .prepare("SELECT cooks_json FROM cook_tasks WHERE request_id = ? AND user_id = ? LIMIT 1")
    .get(id, userId) as { cooks_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.cooks_json) as CookTaskItem[];
}

export async function rememberCookTask(
  requestId: string,
  userId: string,
  cooks: CookTaskItem[],
): Promise<void> {
  if (usePg()) return pg.pgRememberCookTask(requestId, userId, cooks);
  const id = requestId.trim();
  if (!id || !userId) return;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO cook_tasks (request_id, user_id, cooks_json, created_at) VALUES (?,?,?,?)`,
    )
    .run(id, userId, JSON.stringify(cooks), nowIso());
}

export async function enqueueJob(runId: string, type: string, payload: unknown = {}): Promise<string> {
  if (usePg()) return pg.pgEnqueueJob(runId, type, payload);
  const id = crypto.randomUUID();
  const ts = nowIso();
  const run = await getRun(runId);
  const cls = classifyCookJob(run?.pipeline_mode, type);
  const base =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const payloadJson = JSON.stringify({
    ...base,
    ...(cls.heavy ? { heavy: true } : {}),
    ...(cls.archive ? { archive: true } : {}),
    lane: cls.lane,
  });
  getDb()
    .prepare(
      `INSERT INTO jobs (id, run_id, type, status, weight, heavy, archive, payload_json, error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      runId,
      type,
      "pending",
      cls.lane,
      cls.heavy ? 1 : 0,
      cls.archive ? 1 : 0,
      payloadJson,
      null,
      ts,
      ts,
    );
  return id;
}

export async function sessionIdTaken(id: string): Promise<boolean> {
  if (usePg()) return pg.pgSessionIdTaken(id);
  const row = getDb().prepare("SELECT 1 AS ok FROM runs WHERE session_id = ? LIMIT 1").get(id) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

export async function listWaitingRuns(userId?: string): Promise<RunRow[]> {
  if (usePg()) return pg.pgListWaitingRuns(userId);
  if (userId) {
    return getDb()
      .prepare("SELECT * FROM runs WHERE status='waiting_human' AND user_id=? ORDER BY updated_at ASC")
      .all(userId) as RunRow[];
  }
  return getDb()
    .prepare("SELECT * FROM runs WHERE status='waiting_human' ORDER BY updated_at ASC")
    .all() as RunRow[];
}

export async function jobQueueStats(): Promise<{ running: number; pending: number }> {
  if (usePg()) return pg.pgJobQueueStats();
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
       FROM jobs`,
    )
    .get() as { running: number | null; pending: number | null };
  return { running: Number(row.running ?? 0), pending: Number(row.pending ?? 0) };
}

export async function runHasBusyJobs(runId: string): Promise<boolean> {
  if (usePg()) return pg.pgRunHasBusyJobs(runId);
  const row = getDb()
    .prepare(`SELECT 1 AS ok FROM jobs WHERE run_id=? AND status IN ('pending','running') LIMIT 1`)
    .get(runId) as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * GDP `claimNext` port (SQLite):
 *  - light jobs always eligible
 *  - heavy/archive only if running heavy+archive < HEAVY_RUNNING_MAX
 *  - helper lane (audio) only if running helper < HELPER_RUNNING_MAX
 *  - order: lane ASC, created_at ASC
 */
export async function claimNextJob(): Promise<JobRow | undefined> {
  if (usePg()) return pg.pgClaimNextJob();
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const job = database
      .prepare(
        `SELECT j.* FROM jobs j
         WHERE j.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM jobs r WHERE r.run_id = j.run_id AND r.status = 'running'
           )
           AND (
             (COALESCE(j.heavy, 0) = 0 AND COALESCE(j.archive, 0) = 0)
             OR (
               SELECT COUNT(*) FROM jobs rh
               WHERE rh.status = 'running'
                 AND (COALESCE(rh.heavy, 0) = 1 OR COALESCE(rh.archive, 0) = 1)
             ) < ?
           )
           AND (
             COALESCE(j.weight, ${LANE_DEFAULT}) <> ${LANE_HELPER}
             OR (
               SELECT COUNT(*) FROM jobs rh
               WHERE rh.status = 'running'
                 AND COALESCE(rh.weight, ${LANE_DEFAULT}) = ${LANE_HELPER}
             ) < ?
           )
         ORDER BY COALESCE(j.weight, ${LANE_DEFAULT}) ASC, j.created_at ASC
         LIMIT 1`,
      )
      .get(HEAVY_RUNNING_MAX, HELPER_RUNNING_MAX) as JobRow | undefined;
    if (!job) {
      database.exec("COMMIT");
      return undefined;
    }
    const ts = nowIso();
    const result = database
      .prepare("UPDATE jobs SET status='running', updated_at=? WHERE id=? AND status='pending'")
      .run(ts, job.id);
    database.exec("COMMIT");
    if (!Number(result.changes ?? 0)) return undefined;
    return {
      ...job,
      weight: Number(job.weight ?? LANE_DEFAULT),
      heavy: Number(job.heavy ?? 0),
      archive: Number(job.archive ?? 0),
      status: "running",
      updated_at: ts,
    };
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Worker just started — nothing should still be 'running'. */
export async function reclaimRunningJobs(): Promise<number> {
  if (usePg()) return pg.pgReclaimRunningJobs();
  const database = getDb();
  const ts = nowIso();
  // Auto: never silently resume a killed worker mid-clip — that re-submits and re-bills.
  const autoInterrupted = database
    .prepare(
      `SELECT j.id AS id, j.run_id AS run_id FROM jobs j
       INNER JOIN runs r ON r.id = j.run_id
       WHERE j.status = 'running' AND r.pipeline_mode = 'auto'`,
    )
    .all() as Array<{ id: string; run_id: string }>;
  for (const row of autoInterrupted) {
    database
      .prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?")
      .run(
        "error",
        "Scene interrupted (worker restarted). Not auto-resumed — avoids duplicate video charges. Resume retries only this scene; earlier scenes stay kept.",
        ts,
        row.id,
      );
    database
      .prepare("UPDATE runs SET status=?, error=?, gate=NULL, updated_at=? WHERE id=?")
      .run(
        "failed",
        "Stopped: worker interrupted mid-scene. Resume continues from the incomplete scene — prior selected clips are kept.",
        ts,
        row.run_id,
      );
  }
  const result = database
    .prepare("UPDATE jobs SET status='pending', updated_at=? WHERE status='running'")
    .run(ts);
  return Number(result.changes ?? 0) + autoInterrupted.length;
}

export async function finishJob(id: string, status: "done" | "error", error?: string): Promise<void> {
  if (usePg()) return pg.pgFinishJob(id, status, error);
  getDb()
    .prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?")
    .run(status, error ?? null, nowIso(), id);
}

export async function insertVariant(row: Omit<VariantRow, "created_at">): Promise<VariantRow> {
  if (usePg()) return pg.pgInsertVariant(row);
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO variants (
        id, run_id, shot_index, kind, variant_index, path, prompt, model_name,
        selected, rejected, probe_json, uniq_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.run_id,
      row.shot_index,
      row.kind,
      row.variant_index,
      row.path,
      row.prompt,
      row.model_name,
      row.selected,
      row.rejected,
      row.probe_json,
      row.uniq_id,
      ts,
    );
  return { ...row, created_at: ts };
}

export async function listVariants(
  runId: string,
  shotIndex?: number,
  kind?: string,
): Promise<VariantRow[]> {
  if (usePg()) return pg.pgListVariants(runId, shotIndex, kind);
  if (shotIndex !== undefined && kind) {
    return getDb()
      .prepare("SELECT * FROM variants WHERE run_id=? AND shot_index=? AND kind=? ORDER BY variant_index")
      .all(runId, shotIndex, kind) as VariantRow[];
  }
  if (shotIndex !== undefined) {
    return getDb()
      .prepare("SELECT * FROM variants WHERE run_id=? AND shot_index=? ORDER BY kind, variant_index")
      .all(runId, shotIndex) as VariantRow[];
  }
  if (kind) {
    return getDb()
      .prepare("SELECT * FROM variants WHERE run_id=? AND kind=? ORDER BY shot_index, variant_index")
      .all(runId, kind) as VariantRow[];
  }
  return getDb()
    .prepare("SELECT * FROM variants WHERE run_id=? ORDER BY shot_index, kind, variant_index")
    .all(runId) as VariantRow[];
}

export async function getVariant(id: string): Promise<VariantRow | undefined> {
  if (usePg()) return pg.pgGetVariant(id);
  return getDb().prepare("SELECT * FROM variants WHERE id=?").get(id) as VariantRow | undefined;
}

export async function selectVariant(id: string): Promise<void> {
  if (usePg()) return pg.pgSelectVariant(id);
  const v = await getVariant(id);
  if (!v) throw new Error("Unknown variant");
  getDb()
    .prepare("UPDATE variants SET selected=0 WHERE run_id=? AND shot_index=? AND kind=?")
    .run(v.run_id, v.shot_index, v.kind);
  getDb().prepare("UPDATE variants SET selected=1, rejected=0 WHERE id=?").run(id);
}

export async function rejectBatch(
  runId: string,
  shotIndex: number,
  kind: string,
  exceptId?: string,
): Promise<void> {
  if (usePg()) return pg.pgRejectBatch(runId, shotIndex, kind, exceptId);
  if (exceptId) {
    getDb()
      .prepare(
        "UPDATE variants SET rejected=1, selected=0 WHERE run_id=? AND shot_index=? AND kind=? AND id!=?",
      )
      .run(runId, shotIndex, kind, exceptId);
    return;
  }
  getDb()
    .prepare("UPDATE variants SET rejected=1, selected=0 WHERE run_id=? AND shot_index=? AND kind=?")
    .run(runId, shotIndex, kind);
}

export async function upsertAsset(row: Omit<AssetRow, "created_at">): Promise<void> {
  if (usePg()) return pg.pgUpsertAsset(row);
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO assets (uniq_id, run_id, shot_index, role, path, parent_uniq_id, meta_json, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(uniq_id) DO UPDATE SET path=excluded.path, meta_json=excluded.meta_json, parent_uniq_id=excluded.parent_uniq_id`,
    )
    .run(row.uniq_id, row.run_id, row.shot_index, row.role, row.path, row.parent_uniq_id, row.meta_json, ts);
}

export async function listAssets(runId: string): Promise<AssetRow[]> {
  if (usePg()) return pg.pgListAssets(runId);
  return getDb().prepare("SELECT * FROM assets WHERE run_id=? ORDER BY created_at").all(runId) as AssetRow[];
}

export async function upsertReview(row: Omit<ReviewRow, "updated_at">): Promise<void> {
  if (usePg()) return pg.pgUpsertReview(row);
  getDb()
    .prepare(
      `INSERT INTO reviews (run_id, gate, checklist_json, aesthetic_score, consistency_score, use_xfade, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET
         gate=excluded.gate, checklist_json=excluded.checklist_json,
         aesthetic_score=excluded.aesthetic_score, consistency_score=excluded.consistency_score,
         use_xfade=excluded.use_xfade, updated_at=excluded.updated_at`,
    )
    .run(
      row.run_id,
      row.gate,
      row.checklist_json,
      row.aesthetic_score,
      row.consistency_score,
      row.use_xfade,
      nowIso(),
    );
}

export async function getReview(runId: string): Promise<ReviewRow | undefined> {
  if (usePg()) return pg.pgGetReview(runId);
  return getDb().prepare("SELECT * FROM reviews WHERE run_id=?").get(runId) as ReviewRow | undefined;
}

export async function nextReviewRun(userId?: string): Promise<RunRow | undefined> {
  if (usePg()) return pg.pgNextReviewRun(userId);
  if (userId) {
    return getDb()
      .prepare(
        "SELECT * FROM runs WHERE status='waiting_human' AND user_id=? ORDER BY updated_at ASC LIMIT 1",
      )
      .get(userId) as RunRow | undefined;
  }
  return getDb()
    .prepare("SELECT * FROM runs WHERE status='waiting_human' ORDER BY updated_at ASC LIMIT 1")
    .get() as RunRow | undefined;
}

export async function countedByCategory(): Promise<Record<string, number>> {
  if (usePg()) return pg.pgCountedByCategory();
  const rows = getDb()
    .prepare(
      "SELECT category, COUNT(*) as n FROM runs WHERE counted=1 AND status='exported' AND pipeline_mode='agentic' GROUP BY category",
    )
    .all() as Array<{ category: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.category] = Number(r.n);
  return out;
}

export async function countedAspects(): Promise<Record<string, number>> {
  if (usePg()) return pg.pgCountedAspects();
  const rows = getDb()
    .prepare(
      "SELECT aspect_ratio, COUNT(*) as n FROM runs WHERE counted=1 AND status='exported' AND pipeline_mode='agentic' GROUP BY aspect_ratio",
    )
    .all() as Array<{ aspect_ratio: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.aspect_ratio] = Number(r.n);
  return out;
}

export async function countedTotal(): Promise<number> {
  if (usePg()) return pg.pgCountedTotal();
  const row = getDb()
    .prepare("SELECT COUNT(*) as n FROM runs WHERE counted=1 AND status='exported' AND pipeline_mode='agentic'")
    .get() as {
    n: number;
  };
  return Number(row.n);
}

export async function deleteRunRows(id: string): Promise<void> {
  if (usePg()) return pg.pgDeleteRunRows(id);
  const database = getDb();
  if (!(await getRun(id))) throw new Error(`Unknown run ${id}`);
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM jobs WHERE run_id=?").run(id);
    database.prepare("DELETE FROM variants WHERE run_id=?").run(id);
    database.prepare("DELETE FROM assets WHERE run_id=?").run(id);
    database.prepare("DELETE FROM reviews WHERE run_id=?").run(id);
    database.prepare("DELETE FROM cook_requests WHERE run_id=?").run(id);
    database.prepare("DELETE FROM runs WHERE id=?").run(id);
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}
