import { ok } from "@/src/api";
import { readMetaJsonl, listDatasetMedia } from "@/src/pipeline/export";
import { loadAntiPrompts } from "@/src/pipeline/antiprompt";
import { countedTotal, listRuns } from "@/src/db";
import type { MetaRecord } from "@/src/pipeline/schema";

export async function GET() {
  let records: MetaRecord[] = [];
  let parseError: string | null = null;
  try {
    records = readMetaJsonl();
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  const files = listDatasetMedia();
  const rejected = (await listRuns()).filter((r) => r.status === "rejected").length;
  return ok({
    counted: await countedTotal(),
    rejected,
    records,
    parseError,
    files,
    antiPromptCount: loadAntiPrompts().length,
  });
}
