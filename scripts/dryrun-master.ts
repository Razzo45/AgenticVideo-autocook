import path from "node:path";
import { execFileSync } from "node:child_process";
import { conformExactDelivery } from "../src/pipeline/stitch";

async function main() {
  const [inPath, frames = "269"] = process.argv.slice(2);
  if (!inPath) throw new Error("usage: dryrun-master.ts <final.mp4> [frames]");
  const outPath = path.join(path.dirname(inPath), "dryrun_master.mov");
  await conformExactDelivery({ inPath, outPath, width: 3840, height: 2160, fps: "24", frames: Number(frames), codec: "prores4444" });
  const out = execFileSync("ffprobe", [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,profile,width,height,r_frame_rate,nb_read_frames,pix_fmt,color_primaries,color_transfer,color_space",
    "-of", "json", outPath,
  ]).toString();
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
