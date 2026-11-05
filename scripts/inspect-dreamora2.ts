import { getDb } from "../src/db";
import { probeFile } from "../src/pipeline/stitch";

const db = getDb();
const jobs = db
  .prepare(
    `SELECT type, status, substr(coalesce(error,''),1,160) AS e FROM jobs WHERE run_id=? ORDER BY rowid`,
  )
  .all("run_4fdb8fec");
console.log("jobs", jobs);

const clips = [
  "runs/run_4fdb8fec/shot_0/clips/b70c2d60-1a30-4480-a9cb-0b21a02185f3.mp4",
  "runs/run_4fdb8fec/shot_1/clips/541b57a0-e204-48d8-a358-a4ba3590a617.mp4",
  "runs/run_4fdb8fec/final_norm_0.mp4",
  "runs/run_4fdb8fec/final_norm_1.mp4",
  "runs/run_4fdb8fec/final.mp4",
];
async function main() {
  for (const p of clips) {
    const pr = await probeFile(p);
    console.log(p.replace(/.*run_4fdb8fec[\\/]/, ""), {
      w: pr.width,
      h: pr.height,
      dur: pr.duration,
      fps: pr.fps,
    });
  }
}
main();
