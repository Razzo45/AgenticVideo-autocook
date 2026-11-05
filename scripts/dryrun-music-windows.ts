/** Usage: npx tsx scripts/dryrun-music-windows.ts <dialogueVideo> <music> <out> <start-end,...> */
import { mixMusicBed } from "../src/pipeline/stitch";

async function main() {
  const [video, music, output, spans] = process.argv.slice(2);
  const windows = spans.split(",").map((s) => {
    const [a, b] = s.split("-").map(Number);
    return { start: a, end: Number.isFinite(b) ? b : Number.POSITIVE_INFINITY };
  });
  await mixMusicBed({ video, music, output, windows });
  console.log("[ok]", output, JSON.stringify(windows));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
