/** Usage: npx tsx scripts/dryrun-logo-bug.ts <video> <out> <lightLogo> <darkLogo> <start-end,...> */
import { overlayLogoBug } from "../src/pipeline/stitch";

async function main() {
  const [video, output, light, dark, spans] = process.argv.slice(2);
  const windows = spans.split(",").map((s) => {
    const [a, b] = s.split("-").map(Number);
    return { start: a, end: b };
  });
  await overlayLogoBug({ video, output, windows, light, dark });
  console.log("[ok]", output);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
