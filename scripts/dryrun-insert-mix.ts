/**
 * Exercise buildInsertClip + mixMusicBed on real files.
 *
 * Usage: npx tsx scripts/dryrun-insert-mix.ts <audioClip> <footage> <start> <end> <video> <music> <outDir>
 */
import path from "node:path";
import { buildInsertClip, mixMusicBed, probeFile } from "../src/pipeline/stitch";

async function main() {
  const [audioClip, footage, start, end, video, music, outDir] = process.argv.slice(2);
  const insertOut = path.resolve(outDir!, "dryrun-insert.mp4");
  await buildInsertClip({ source: footage!, start: Number(start), end: Number(end), audioClip: audioClip!, output: insertOut });
  const [a, i] = await Promise.all([probeFile(audioClip!), probeFile(insertOut)]);
  console.log(`[insert] ${insertOut}: ${i.width}x${i.height} ${i.duration?.toFixed(2)}s audio=${i.hasAudio} (clip ${a.duration?.toFixed(2)}s)`);

  const mixOut = path.resolve(outDir!, path.basename(video!).replace(/\.mp4$/i, "_music.mp4"));
  const t0 = Date.now();
  await mixMusicBed({ video: video!, music: music!, output: mixOut });
  const m = await probeFile(mixOut);
  console.log(`[mix] ${mixOut}: ${m.duration?.toFixed(2)}s ${m.fps}fps in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
