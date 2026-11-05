/**
 * Re-render a run's exact-frame delivery master from its stitched final.mp4, keeping audio.
 *
 * Usage: npx tsx scripts/remaster-with-audio.ts <runId> <fps> <frames>
 */
import path from "node:path";
import { conformExactDelivery } from "../src/pipeline/stitch";
import { runDir } from "../src/pipeline/paths";

async function main() {
  const [runId, fps = "25", framesArg] = process.argv.slice(2);
  if (!runId || !framesArg) throw new Error("usage: remaster-with-audio.ts <runId> <fps> <frames>");
  const dir = runDir(runId);
  const outPath = path.join(dir, "final_master.mp4");
  await conformExactDelivery({
    inPath: path.join(dir, "final.mp4"),
    outPath,
    width: 3840,
    height: 2160,
    fps,
    frames: Number(framesArg),
    codec: "h264",
    keepAudio: true,
  });
  console.log(`[master] ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
