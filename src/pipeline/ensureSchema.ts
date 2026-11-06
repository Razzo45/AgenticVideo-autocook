/**
 * Idempotent apply of sql/001 + sql/002 when DATABASE_URL is set.
 * Safe to call from web and worker on boot.
 */
import fs from "node:fs";
import path from "node:path";
import { getPgPool, postgresConfigured } from "./pg";

let applied = false;

export async function ensureRailwaySchema(): Promise<void> {
  if (applied || !postgresConfigured()) return;
  const pool = getPgPool();
  if (!pool) return;
  const root = process.cwd();
  const files = ["sql/001_railway_gemini.sql", "sql/002_runs_ownership.sql", "sql/003_cook_tasks.sql"];
  const client = await pool.connect();
  try {
    for (const rel of files) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) {
        console.warn("[schema] missing", rel);
        continue;
      }
      const sql = fs.readFileSync(abs, "utf8");
      await client.query(sql);
      console.log("[schema] applied", rel);
    }
    applied = true;
  } catch (err) {
    console.warn("[schema] apply failed", err instanceof Error ? err.message : err);
  } finally {
    client.release();
  }
}
