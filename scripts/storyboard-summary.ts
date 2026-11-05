/** One line per shot: flags, callout, and the first words of each prompt. Usage: npx tsx scripts/storyboard-summary.ts <runId> */
import { getRun } from "../src/db";
import type { ScriptPlan } from "../src/pipeline/schema";

const run = getRun(process.argv[2]);
if (!run?.script_json) throw new Error("no storyboard yet");
const s = JSON.parse(run.script_json) as ScriptPlan;
console.log(`callout_color=${s.callout_color ?? "-"} shots=${s.shots.length}`);
s.shots.forEach((x, i) => {
  const flags = `${x.transition[0]} m=${x.music ?? "-"} l=${x.logo_bug ?? "-"}`;
  const quote = x.motion_prompt.match(/["“'‘]([^"”]{12,})["”]/)?.[1];
  console.log(
    `${String(i).padStart(2)} ${flags}${x.callout ? ` [${x.callout}]` : ""} | ${x.image_prompt.slice(0, 90)} | VO: ${quote ? quote.slice(0, 70) : "(none)"}`,
  );
});
