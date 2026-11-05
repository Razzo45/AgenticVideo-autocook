import { getRun } from "../src/db";
import { sceneProgressForRun } from "../src/pipeline/orchestrator";
import { MAX_DURATION_AUTO_SEC, TYPICAL_AUTO_CLIP_SEC } from "../src/pipeline/constants";

console.log({ MAX_DURATION_AUTO_SEC, TYPICAL_AUTO_CLIP_SEC });
const run = getRun("run_f2c457c0");
if (!run) {
  console.log("no run");
  process.exit(0);
}
const sp = sceneProgressForRun(run);
console.log({
  status: run.status,
  completed: sp?.completed,
  current: sp?.current,
  total: sp?.total,
  next: sp?.nextAction,
});
