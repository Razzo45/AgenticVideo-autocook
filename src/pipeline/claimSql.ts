/**
 * Which pending job the worker takes next. Shared by the SQLite and Postgres backends.
 *
 * Rules, in order:
 *  1. Never two jobs of one run at once.
 *  2. task_plan is text: it runs whenever a worker slot is free.
 *  3. Deliverable jobs: at most DELIVERABLE_SLOTS at once, and at most one of them
 *     makes video (clips are the heaviest calls on the key).
 *  4. Order: a run already past its first generation stage finishes first; then
 *     people with nothing running go before people who already have a task running;
 *     then the lightest plan, where every AGING_MINUTES of waiting counts as one
 *     deliverable unit lighter, so a heavy task is not passed over forever.
 */
import { TASK_PLAN_JOB_SQL } from "./taskJobs";

export type ClaimDialect = "sqlite" | "postgres";

/** Deliverable tasks generating at the same time across everyone. */
export function deliverableSlots(): number {
  const n = Math.floor(Number(process.env.TASK_EXECUTE_CONCURRENCY));
  return Number.isFinite(n) && n >= 1 ? Math.min(8, n) : 2;
}

/** Minutes of waiting that make a task count one unit (weight 10) lighter. */
export function agingMinutes(): number {
  const n = Number(process.env.QUEUE_AGING_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** Worker slots: every deliverable slot plus one for plan reads. */
export function workerSlots(configured: number): number {
  return Math.max(configured, deliverableSlots() + 1);
}

/** A job that may generate video: a task whose plan lists video, or a legacy video/audio cook. */
function videoClass(job: string, run: string): string {
  return `(${job}.payload_json LIKE '%"deliverable":"video"%' OR ${run}.pipeline_mode IN ('auto','direct','agentic'))`;
}

export function claimSql(dialect: ClaimDialect, opts?: { slots?: number; aging?: number }): string {
  const t = dialect === "postgres" ? "app." : "";
  const slots = Math.max(1, Math.floor(opts?.slots ?? deliverableSlots()));
  const aging = opts?.aging ?? agingMinutes();
  const waited =
    dialect === "postgres"
      ? `(EXTRACT(EPOCH FROM (now() - j.created_at)) / 60.0)`
      : `((julianday('now') - julianday(j.created_at)) * 1440.0)`;
  const plan = TASK_PLAN_JOB_SQL;
  return `SELECT j.* FROM ${t}jobs j
  JOIN ${t}runs r ON r.id = j.run_id
  WHERE j.status = 'pending'
    AND NOT EXISTS (SELECT 1 FROM ${t}jobs x WHERE x.run_id = j.run_id AND x.status = 'running')
    AND (
      j.type IN (${plan})
      OR (
        (SELECT COUNT(*) FROM ${t}jobs b WHERE b.status = 'running' AND b.type NOT IN (${plan})) < ${slots}
        AND (
          NOT ${videoClass("j", "r")}
          OR NOT EXISTS (
            SELECT 1 FROM ${t}jobs v JOIN ${t}runs vr ON vr.id = v.run_id
            WHERE v.status = 'running' AND v.type NOT IN (${plan}) AND ${videoClass("v", "vr")}
          )
        )
      )
    )
  ORDER BY
    CASE
      WHEN j.type NOT IN (${plan}) AND EXISTS (
        SELECT 1 FROM ${t}jobs prev
        WHERE prev.run_id = j.run_id AND prev.status = 'done' AND prev.type NOT IN (${plan})
      ) THEN 0
      WHEN j.type NOT IN (${plan}) THEN 1
      ELSE 2
    END,
    CASE WHEN j.type IN (${plan}) THEN 0 ELSE (
      SELECT COUNT(*) FROM ${t}jobs u JOIN ${t}runs ur ON ur.id = u.run_id
      WHERE u.status = 'running' AND u.type NOT IN (${plan}) AND ur.user_id = r.user_id
    ) END ASC,
    CASE WHEN j.type IN (${plan}) THEN 0 ELSE COALESCE(j.task_weight, 10) - (10.0 * ${waited} / ${aging}) END ASC,
    j.created_at ASC
  LIMIT 1`;
}
