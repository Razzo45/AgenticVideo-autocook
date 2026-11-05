/** Usage: npx tsx scripts/peek-storyboard.ts <runId> */
import { getRun } from "../src/db";

const run = getRun(process.argv[2]);
if (!run?.script_json) throw new Error("no storyboard yet");
const s = JSON.parse(run.script_json) as {
  subjects?: string[];
  shots: Array<{
    duration?: number;
    insert?: unknown;
    music?: boolean | null;
    logo_bug?: boolean | null;
    image_prompt?: string;
    motion_prompt?: string;
  }>;
};
console.log("subjects", JSON.stringify(s.subjects));
s.shots.forEach((x, i) => {
  console.log(
    `--- shot ${i} dur=${x.duration} insert=${JSON.stringify(x.insert ?? null)} music=${x.music ?? "-"} logo_bug=${x.logo_bug ?? "-"}`,
  );
  console.log("IMG:", x.image_prompt);
  console.log("MOTION:", x.motion_prompt);
});
