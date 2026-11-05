import { ok } from "@/src/api";
import { ensureRailwaySchema } from "@/src/pipeline/ensureSchema";
import { postgresConfigured } from "@/src/pipeline/pg";
import { storageMode } from "@/src/pipeline/storage";

export async function GET() {
  // Best-effort schema ensure so web can migrate even if worker is slow to start.
  if (postgresConfigured()) {
    void ensureRailwaySchema();
  }
  return ok({
    ok: true,
    service: "autocook",
    time: new Date().toISOString(),
    postgres: postgresConfigured(),
    authMode: (process.env.AUTH_MODE ?? "dev").toLowerCase(),
    storage: storageMode(),
  });
}
