/**
 * Regex-replace text in one shot's image_prompt / motion_prompt of a run's storyboard.
 * Usage: npx tsx scripts/patch-shot-prompt.ts <runId> <shotIndex> <regex> <replacement>
 */
import { getDb, getRun } from "../src/db";

const [runId, shotArg, pattern, replacement] = process.argv.slice(2);
const run = getRun(runId);
if (!run?.script_json) throw new Error("no storyboard");
const script = JSON.parse(run.script_json) as { shots: Array<{ image_prompt: string; motion_prompt: string }> };
const shot = script.shots[Number(shotArg)];
const re = new RegExp(pattern, "gi");
for (const key of ["image_prompt", "motion_prompt"] as const) {
  const next = shot[key].replace(re, replacement).replace(/\s{2,}/g, " ").replace(/\s+,/g, ",");
  if (next !== shot[key]) console.log(`[${key}] ${next}`);
  shot[key] = next;
}
getDb().prepare("UPDATE runs SET script_json=? WHERE id=?").run(JSON.stringify(script), runId);
