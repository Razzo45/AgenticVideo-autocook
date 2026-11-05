/** Usage: npx tsx scripts/peek-variant-prompt.ts <variantId> */
import { getDb } from "../src/db";

const row = getDb()
  .prepare("SELECT kind, shot_index, model_name, prompt FROM variants WHERE id = ?")
  .get(process.argv[2]) as { kind: string; shot_index: number; model_name: string; prompt: string } | undefined;
if (!row) throw new Error("no such variant");
console.log(`[${row.kind}] scene ${row.shot_index + 1} model=${row.model_name}`);
console.log(row.prompt);
