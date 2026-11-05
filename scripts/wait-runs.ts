/** Wait until listed runs leave generating/queued/stitching. Usage: npx tsx scripts/wait-runs.ts <id>... */
import { getRun } from "../src/db";

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error("usage: wait-runs.ts <runId>...");

  const done = new Set(["exported", "failed", "cancelled"]);
  const start = Date.now();
  const maxMs = 45 * 60 * 1000;

  while (Date.now() - start < maxMs) {
    const rows = ids.map((id) => {
      const r = getRun(id);
      return {
        id,
        status: r?.status ?? "missing",
        mode: r?.pipeline_mode,
        err: (r?.error || "").slice(0, 100),
      };
    });
    console.log(`[${Math.round((Date.now() - start) / 1000)}s]`, JSON.stringify(rows));
    if (rows.every((r) => done.has(r.status) || r.status === "missing")) break;
    await new Promise((r) => setTimeout(r, 15000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
