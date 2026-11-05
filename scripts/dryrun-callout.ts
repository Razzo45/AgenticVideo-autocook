/** Usage: npx tsx scripts/dryrun-callout.ts <video> <outDir> [hex] */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { overlayLogoBug } from "../src/pipeline/stitch";

async function main() {
  const [video, outDir, hex] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const cut = path.join(outDir, "cut.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "20", "-t", "10", "-i", video, "-c:v", "libx264", "-crf", "18", "-c:a", "aac", cut]);
  const out = path.join(outDir, "callout.mp4");
  await overlayLogoBug({
    video: cut,
    output: out,
    windows: [],
    callouts: [{ start: 1, end: 9, text: "EXISTING BOOKING REMAINS VALID" }],
    calloutColor: hex,
  });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "5", "-i", out, "-frames:v", "1", "-vf", "scale=1280:-2", path.join(outDir, "frame.jpg")]);
  console.log("[ok]", path.join(outDir, "frame.jpg"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
