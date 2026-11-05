import { getRun, updateRun } from "../src/db";

const runId = "run_51a7fa64";
const run = getRun(runId)!;
const script = JSON.parse(run.script_json!);
const shot = script.shots[3]!;
shot.media_desc =
  "Marcus on camera explaining required PPE items. Graphics for this section are handled in the final edit, not in this live take.";
shot.motion_prompt =
  "Marcus Reed speaks clearly to camera in a calm instructional tone. Small natural hand gesture only. Single continuous talking-head take. Static camera. No cuts, no title cards, no lower thirds, no logos, no on-screen text, no UI.";
updateRun(runId, { script_json: JSON.stringify(script) });
console.log("patched media_desc + motion; current run status", run.status, run.error?.slice(0, 120));
