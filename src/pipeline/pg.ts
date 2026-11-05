/**
 * Optional Postgres (Railway DATABASE_URL). When unset, callers fall back to SQLite / local.
 */
import pg from "pg";

let pool: pg.Pool | null = null;
let unavailable = false;

export function postgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim()) && !unavailable;
}

export function getPgPool(): pg.Pool | null {
  if (!postgresConfigured()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX) || 8,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => {
      console.warn("[pg] pool error", err.message);
    });
  }
  return pool;
}

export async function pgQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const p = getPgPool();
  if (!p) return [];
  try {
    const res = await p.query<T>(text, params);
    return res.rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist|undefined function|relation .* does not exist/i.test(msg)) {
      console.warn("[pg] schema missing — apply sql/001_railway_gemini.sql:", msg.slice(0, 160));
    }
    throw err;
  }
}

export function markPostgresUnavailable(reason: string): void {
  unavailable = true;
  console.warn("[pg] disabled for this process:", reason);
}
