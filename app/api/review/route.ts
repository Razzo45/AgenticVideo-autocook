import { ok } from "@/src/api";
import { listWaitingRuns } from "@/src/db";

export async function GET() {
  const runs = await listWaitingRuns();
  return ok({
    run: runs[0] ?? null,
    runs: runs.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      category: r.category,
      gate: r.gate,
      initial_prompt: r.initial_prompt,
      updated_at: r.updated_at,
    })),
  });
}
