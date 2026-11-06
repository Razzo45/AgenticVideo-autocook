/**
 * Postgres backend for runs/jobs when DATABASE_URL is set (Railway web+worker share).
 */
import { pgQuery, getPgPool, postgresConfigured } from "../pipeline/pg";
import type { Gate, OutputResolution, PipelineMode, RunStatus } from "../pipeline/constants";
import {
  classifyCookJob,
  HEAVY_RUNNING_MAX,
  HELPER_RUNNING_MAX,
  LANE_DEFAULT,
  LANE_HELPER,
} from "../pipeline/jobLanes";
import type { AssetRow, JobRow, ReviewRow, RunRow, VariantRow } from "./types";

export { postgresConfigured };

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "");
}

function mapRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    session_id: String(r.session_id),
    status: r.status as RunStatus,
    category: String(r.category),
    aspect_ratio: String(r.aspect_ratio),
    target_duration: Number(r.target_duration),
    output_resolution: (r.output_resolution as OutputResolution) ?? "1080p",
    initial_prompt: String(r.initial_prompt),
    script_model: String(r.script_model),
    keyframe_model: String(r.keyframe_model),
    video_model: String(r.video_model),
    current_shot_index: Number(r.current_shot_index ?? 0),
    rework_round: Number(r.rework_round ?? 0),
    gate: (r.gate as Gate | null) ?? null,
    revise_comment: r.revise_comment != null ? String(r.revise_comment) : null,
    script_json: r.script_json != null ? String(r.script_json) : null,
    input_assets_json: r.input_assets_json != null ? String(r.input_assets_json) : null,
    pipeline_mode: (r.pipeline_mode as PipelineMode) ?? "agentic",
    operator_script: r.operator_script != null ? String(r.operator_script) : null,
    auto_options_json: r.auto_options_json != null ? String(r.auto_options_json) : null,
    error: r.error != null ? String(r.error) : null,
    counted: Number(r.counted ?? 0),
    user_id: String(r.user_id ?? ""),
    tenant_id: r.tenant_id != null ? String(r.tenant_id) : null,
    created_by_kind: String(r.created_by_kind ?? "dev"),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function mapJob(r: Record<string, unknown>): JobRow {
  return {
    id: String(r.id),
    run_id: String(r.run_id),
    type: String(r.type),
    status: r.status as JobRow["status"],
    weight: Number(r.weight ?? LANE_DEFAULT),
    heavy: Number(r.heavy ?? 0),
    archive: Number(r.archive ?? 0),
    payload_json: String(r.payload_json ?? "{}"),
    error: r.error != null ? String(r.error) : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export async function pgInsertRun(row: Omit<RunRow, "created_at" | "updated_at">): Promise<RunRow> {
  const rows = await pgQuery<Record<string, unknown>>(
    `INSERT INTO app.runs (
      id, session_id, status, category, aspect_ratio, target_duration, initial_prompt,
      script_model, keyframe_model, video_model, current_shot_index, rework_round, gate,
      revise_comment, script_json, input_assets_json, pipeline_mode, operator_script,
      output_resolution, auto_options_json, error, counted, user_id, tenant_id, created_by_kind
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
    ) RETURNING *`,
    [
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
      row.user_id,
      row.tenant_id,
      row.created_by_kind ?? "dev",
    ],
  );
  return mapRun(rows[0]!);
}

export async function pgGetRun(id: string): Promise<RunRow | undefined> {
  const rows = await pgQuery<Record<string, unknown>>(`SELECT * FROM app.runs WHERE id = $1`, [id]);
  return rows[0] ? mapRun(rows[0]) : undefined;
}

export async function pgListRuns(userId?: string): Promise<RunRow[]> {
  if (userId) {
    const rows = await pgQuery<Record<string, unknown>>(
      `SELECT * FROM app.runs WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(mapRun);
  }
  const rows = await pgQuery<Record<string, unknown>>(`SELECT * FROM app.runs ORDER BY created_at DESC`);
  return rows.map(mapRun);
}

export async function pgUpdateRun(id: string, patch: Partial<RunRow>): Promise<void> {
  const current = await pgGetRun(id);
  if (!current) throw new Error(`Unknown run ${id}`);
  const next = { ...current, ...patch };
  await pgQuery(
    `UPDATE app.runs SET
      status=$1, current_shot_index=$2, rework_round=$3, gate=$4, revise_comment=$5,
      script_json=$6, error=$7, counted=$8, script_model=$9, keyframe_model=$10, video_model=$11,
      updated_at=now()
     WHERE id=$12`,
    [
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
      id,
    ],
  );
}

export async function pgSetRunInputAssets(id: string, inputAssetsJson: string): Promise<void> {
  await pgQuery(`UPDATE app.runs SET input_assets_json=$1, updated_at=now() WHERE id=$2`, [
    inputAssetsJson,
    id,
  ]);
}

export async function pgFindRunByRequestId(requestId: string, userId: string): Promise<RunRow | undefined> {
  const id = requestId.trim();
  if (!id || !userId) return undefined;
  const rows = await pgQuery<{ run_id: string }>(
    `SELECT run_id FROM app.cook_requests WHERE request_id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId],
  );
  return rows[0] ? pgGetRun(rows[0].run_id) : undefined;
}

export async function pgFindCookTask(
  requestId: string,
  userId: string,
): Promise<Array<{ kind: string; label: string; brief: string; runId: string; requestId: string }> | undefined> {
  const id = requestId.trim();
  if (!id || !userId) return undefined;
  const rows = await pgQuery<{ cooks_json: string }>(
    `SELECT cooks_json FROM app.cook_tasks WHERE request_id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId],
  );
  if (!rows[0]) return undefined;
  return JSON.parse(rows[0].cooks_json) as Array<{
    kind: string;
    label: string;
    brief: string;
    runId: string;
    requestId: string;
  }>;
}

export async function pgRememberCookTask(
  requestId: string,
  userId: string,
  cooks: Array<{ kind: string; label: string; brief: string; runId: string; requestId: string }>,
): Promise<void> {
  const id = requestId.trim();
  if (!id || !userId) return;
  await pgQuery(
    `INSERT INTO app.cook_tasks (request_id, user_id, cooks_json) VALUES ($1,$2,$3)
     ON CONFLICT (request_id, user_id) DO NOTHING`,
    [id, userId, JSON.stringify(cooks)],
  );
}

export async function pgRememberCookRequest(requestId: string, runId: string, userId: string): Promise<void> {
  const id = requestId.trim();
  if (!id || !userId) return;
  await pgQuery(
    `INSERT INTO app.cook_requests (request_id, user_id, run_id) VALUES ($1,$2,$3)
     ON CONFLICT (request_id, user_id) DO NOTHING`,
    [id, userId, runId],
  );
}

export async function pgEnqueueJob(runId: string, type: string, payload: unknown = {}): Promise<string> {
  const id = crypto.randomUUID();
  const run = await pgGetRun(runId);
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
  await pgQuery(
    `INSERT INTO app.jobs (id, run_id, type, status, weight, heavy, archive, payload_json)
     VALUES ($1,$2,$3,'pending',$4,$5,$6,$7)`,
    [id, runId, type, cls.lane, cls.heavy ? 1 : 0, cls.archive ? 1 : 0, payloadJson],
  );
  return id;
}

export async function pgSessionIdTaken(sessionId: string): Promise<boolean> {
  const rows = await pgQuery<{ ok: number }>(
    `SELECT 1 AS ok FROM app.runs WHERE session_id = $1 LIMIT 1`,
    [sessionId],
  );
  return Boolean(rows[0]);
}

export async function pgClaimNextJob(): Promise<JobRow | undefined> {
  const pool = getPgPool();
  if (!pool) return undefined;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT j.* FROM app.jobs j
       WHERE j.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM app.jobs r WHERE r.run_id = j.run_id AND r.status = 'running'
         )
         AND (
           (COALESCE(j.heavy, 0) = 0 AND COALESCE(j.archive, 0) = 0)
           OR (
             SELECT COUNT(*) FROM app.jobs rh
             WHERE rh.status = 'running'
               AND (COALESCE(rh.heavy, 0) = 1 OR COALESCE(rh.archive, 0) = 1)
           ) < $1
         )
         AND (
           COALESCE(j.weight, ${LANE_DEFAULT}) <> ${LANE_HELPER}
           OR (
             SELECT COUNT(*) FROM app.jobs rh
             WHERE rh.status = 'running'
               AND COALESCE(rh.weight, ${LANE_DEFAULT}) = ${LANE_HELPER}
           ) < $2
         )
       ORDER BY COALESCE(j.weight, ${LANE_DEFAULT}) ASC, j.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [HEAVY_RUNNING_MAX, HELPER_RUNNING_MAX],
    );
    const job = sel.rows[0] as Record<string, unknown> | undefined;
    if (!job) {
      await client.query("COMMIT");
      return undefined;
    }
    const upd = await client.query(
      `UPDATE app.jobs SET status='running', updated_at=now()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [job.id],
    );
    await client.query("COMMIT");
    if (!upd.rows[0]) return undefined;
    return mapJob(upd.rows[0] as Record<string, unknown>);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pgReclaimRunningJobs(): Promise<number> {
  const autoInterrupted = await pgQuery<{ id: string; run_id: string }>(
    `SELECT j.id AS id, j.run_id AS run_id FROM app.jobs j
     INNER JOIN app.runs r ON r.id = j.run_id
     WHERE j.status = 'running' AND r.pipeline_mode = 'auto'`,
  );
  for (const row of autoInterrupted) {
    await pgQuery(`UPDATE app.jobs SET status='error', error=$1, updated_at=now() WHERE id=$2`, [
      "Scene interrupted (worker restarted). Not auto-resumed — avoids duplicate video charges.",
      row.id,
    ]);
    await pgQuery(
      `UPDATE app.runs SET status='failed', error=$1, gate=NULL, updated_at=now() WHERE id=$2`,
      [
        "Stopped: worker interrupted mid-scene. Resume continues from the incomplete scene — prior selected clips are kept.",
        row.run_id,
      ],
    );
  }
  const res = await pgQuery(`UPDATE app.jobs SET status='pending', updated_at=now() WHERE status='running' RETURNING id`);
  return res.length + autoInterrupted.length;
}

export async function pgFinishJob(id: string, status: "done" | "error", error?: string): Promise<void> {
  await pgQuery(`UPDATE app.jobs SET status=$1, error=$2, updated_at=now() WHERE id=$3`, [
    status,
    error ?? null,
    id,
  ]);
}

export async function pgJobQueueStats(): Promise<{ running: number; pending: number }> {
  const rows = await pgQuery<{ running: string; pending: string }>(
    `SELECT
       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END)::text AS running,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)::text AS pending
     FROM app.jobs`,
  );
  const row = rows[0];
  return { running: Number(row?.running ?? 0), pending: Number(row?.pending ?? 0) };
}

export async function pgRunHasBusyJobs(runId: string): Promise<boolean> {
  const rows = await pgQuery<{ ok: number }>(
    `SELECT 1 AS ok FROM app.jobs WHERE run_id=$1 AND status IN ('pending','running') LIMIT 1`,
    [runId],
  );
  return Boolean(rows[0]);
}

export async function pgListWaitingRuns(userId?: string): Promise<RunRow[]> {
  if (userId) {
    const rows = await pgQuery<Record<string, unknown>>(
      `SELECT * FROM app.runs WHERE status='waiting_human' AND user_id=$1 ORDER BY updated_at ASC`,
      [userId],
    );
    return rows.map(mapRun);
  }
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT * FROM app.runs WHERE status='waiting_human' ORDER BY updated_at ASC`,
  );
  return rows.map(mapRun);
}

export async function pgInsertVariant(row: Omit<VariantRow, "created_at">): Promise<VariantRow> {
  const rows = await pgQuery<Record<string, unknown>>(
    `INSERT INTO app.variants (
      id, run_id, shot_index, kind, variant_index, path, prompt, model_name,
      selected, rejected, probe_json, uniq_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
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
    ],
  );
  const r = rows[0]!;
  return { ...row, created_at: iso(r.created_at) };
}

export async function pgListVariants(runId: string, shotIndex?: number, kind?: string): Promise<VariantRow[]> {
  let sql = `SELECT * FROM app.variants WHERE run_id=$1`;
  const params: unknown[] = [runId];
  if (shotIndex !== undefined) {
    params.push(shotIndex);
    sql += ` AND shot_index=$${params.length}`;
  }
  if (kind) {
    params.push(kind);
    sql += ` AND kind=$${params.length}`;
  }
  sql += ` ORDER BY shot_index, kind, variant_index`;
  const rows = await pgQuery<Record<string, unknown>>(sql, params);
  return rows.map((r) => ({
    id: String(r.id),
    run_id: String(r.run_id),
    shot_index: Number(r.shot_index),
    kind: r.kind as VariantRow["kind"],
    variant_index: Number(r.variant_index),
    path: String(r.path),
    prompt: String(r.prompt),
    model_name: String(r.model_name),
    selected: Number(r.selected),
    rejected: Number(r.rejected),
    probe_json: r.probe_json != null ? String(r.probe_json) : null,
    uniq_id: r.uniq_id != null ? String(r.uniq_id) : null,
    created_at: iso(r.created_at),
  }));
}

export async function pgGetVariant(id: string): Promise<VariantRow | undefined> {
  const rows = await pgQuery<Record<string, unknown>>(`SELECT * FROM app.variants WHERE id=$1`, [id]);
  if (!rows[0]) return undefined;
  const list = await pgListVariants(String(rows[0].run_id));
  return list.find((v) => v.id === id);
}

export async function pgSelectVariant(id: string): Promise<void> {
  const v = await pgGetVariant(id);
  if (!v) throw new Error("Unknown variant");
  await pgQuery(`UPDATE app.variants SET selected=0 WHERE run_id=$1 AND shot_index=$2 AND kind=$3`, [
    v.run_id,
    v.shot_index,
    v.kind,
  ]);
  await pgQuery(`UPDATE app.variants SET selected=1, rejected=0 WHERE id=$1`, [id]);
}

export async function pgRejectBatch(
  runId: string,
  shotIndex: number,
  kind: string,
  exceptId?: string,
): Promise<void> {
  if (exceptId) {
    await pgQuery(
      `UPDATE app.variants SET rejected=1, selected=0
       WHERE run_id=$1 AND shot_index=$2 AND kind=$3 AND id<>$4`,
      [runId, shotIndex, kind, exceptId],
    );
    return;
  }
  await pgQuery(
    `UPDATE app.variants SET rejected=1, selected=0 WHERE run_id=$1 AND shot_index=$2 AND kind=$3`,
    [runId, shotIndex, kind],
  );
}

export async function pgUpsertAsset(row: Omit<AssetRow, "created_at">): Promise<void> {
  await pgQuery(
    `INSERT INTO app.assets (uniq_id, run_id, shot_index, role, path, parent_uniq_id, meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (uniq_id) DO UPDATE SET
       path=excluded.path, meta_json=excluded.meta_json, parent_uniq_id=excluded.parent_uniq_id`,
    [row.uniq_id, row.run_id, row.shot_index, row.role, row.path, row.parent_uniq_id, row.meta_json],
  );
}

export async function pgListAssets(runId: string): Promise<AssetRow[]> {
  const rows = await pgQuery<Record<string, unknown>>(
    `SELECT * FROM app.assets WHERE run_id=$1 ORDER BY created_at`,
    [runId],
  );
  return rows.map((r) => ({
    uniq_id: String(r.uniq_id),
    run_id: String(r.run_id),
    shot_index: r.shot_index == null ? null : Number(r.shot_index),
    role: String(r.role),
    path: String(r.path),
    parent_uniq_id: r.parent_uniq_id != null ? String(r.parent_uniq_id) : null,
    meta_json: String(r.meta_json),
    created_at: iso(r.created_at),
  }));
}

export async function pgUpsertReview(row: Omit<ReviewRow, "updated_at">): Promise<void> {
  await pgQuery(
    `INSERT INTO app.reviews (run_id, gate, checklist_json, aesthetic_score, consistency_score, use_xfade)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id) DO UPDATE SET
       gate=excluded.gate, checklist_json=excluded.checklist_json,
       aesthetic_score=excluded.aesthetic_score, consistency_score=excluded.consistency_score,
       use_xfade=excluded.use_xfade, updated_at=now()`,
    [
      row.run_id,
      row.gate,
      row.checklist_json,
      row.aesthetic_score,
      row.consistency_score,
      row.use_xfade,
    ],
  );
}

export async function pgGetReview(runId: string): Promise<ReviewRow | undefined> {
  const rows = await pgQuery<Record<string, unknown>>(`SELECT * FROM app.reviews WHERE run_id=$1`, [runId]);
  if (!rows[0]) return undefined;
  const r = rows[0];
  return {
    run_id: String(r.run_id),
    gate: r.gate as Gate,
    checklist_json: r.checklist_json != null ? String(r.checklist_json) : null,
    aesthetic_score: r.aesthetic_score == null ? null : Number(r.aesthetic_score),
    consistency_score: r.consistency_score == null ? null : Number(r.consistency_score),
    use_xfade: Number(r.use_xfade ?? 0),
    updated_at: iso(r.updated_at),
  };
}

export async function pgNextReviewRun(userId?: string): Promise<RunRow | undefined> {
  const list = await pgListWaitingRuns(userId);
  return list[0];
}

export async function pgDeleteRunRows(id: string): Promise<void> {
  const run = await pgGetRun(id);
  if (!run) throw new Error(`Unknown run ${id}`);
  await pgQuery(`DELETE FROM app.runs WHERE id=$1`, [id]);
}

export async function pgCountedTotal(): Promise<number> {
  const rows = await pgQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM app.runs
     WHERE counted=1 AND status='exported' AND pipeline_mode='agentic'`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function pgCountedByCategory(): Promise<Record<string, number>> {
  const rows = await pgQuery<{ category: string; n: string }>(
    `SELECT category, COUNT(*)::text AS n FROM app.runs
     WHERE counted=1 AND status='exported' AND pipeline_mode='agentic' GROUP BY category`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.category] = Number(r.n);
  return out;
}

export async function pgCountedAspects(): Promise<Record<string, number>> {
  const rows = await pgQuery<{ aspect_ratio: string; n: string }>(
    `SELECT aspect_ratio, COUNT(*)::text AS n FROM app.runs
     WHERE counted=1 AND status='exported' AND pipeline_mode='agentic' GROUP BY aspect_ratio`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.aspect_ratio] = Number(r.n);
  return out;
}

export async function pgCountRunsByStatus(userId?: string): Promise<Record<string, number>> {
  const rows = userId
    ? await pgQuery<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM app.runs WHERE user_id=$1 GROUP BY status`,
        [userId],
      )
    : await pgQuery<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM app.runs GROUP BY status`,
      );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function pgTouchRun(id: string): Promise<void> {
  await pgQuery(`UPDATE app.runs SET updated_at=now() WHERE id=$1`, [id]);
}
