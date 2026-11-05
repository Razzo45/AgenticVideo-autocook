/**
 * Re-stitch an exported run from its selected source clips at the brief's delivery fps.
 * Writes runs/<id>/final_<fps>fps.mp4 next to final.mp4 (which is left untouched).
 *
 * Usage: npx tsx scripts/restitch-delivery-fps.ts <runId> [<runId> ...]
 */
import path from "node:path";
import { getDb, listVariants } from "../src/db";
import { deliveryFpsFromPrompt, normalizeOutputResolution, type VideoAspect } from "../src/pipeline/constants";
import { operatorBookendVideos } from "../src/pipeline/inputs";
import { probeFile, stitchSession } from "../src/pipeline/stitch";

async function main() {
  const db = getDb();
  for (const id of process.argv.slice(2)) {
    const run = db
      .prepare("SELECT id, aspect_ratio, output_resolution, initial_prompt, script_json, input_assets_json FROM runs WHERE id = ?")
      .get(id) as
      | {
          id: string;
          aspect_ratio: string;
          output_resolution: string | null;
          initial_prompt: string;
          script_json: string;
          input_assets_json: string | null;
        }
      | undefined;
    if (!run) throw new Error(`No run ${id}`);
    const shots = (JSON.parse(run.script_json) as { shots: unknown[] }).shots.length;
    const clips: string[] = [];
    for (let i = 0; i < shots; i++) {
      const v = listVariants(id, i, "clip").find((x) => x.selected);
      if (!v) throw new Error(`${id}: shot ${i} has no selected clip`);
      clips.push(v.path);
    }
    const fps = deliveryFpsFromPrompt(run.initial_prompt);
    const label = fps === "24000/1001" ? "23.976" : fps === "30000/1001" ? "29.97" : fps;
    const out = path.join("runs", id, `final_${label}fps.mp4`);
    const bookends = operatorBookendVideos(run.input_assets_json);
    console.log(`[${id}] ${clips.length} clips -> ${out} @ ${fps}`);
    const t0 = Date.now();
    await stitchSession(
      clips,
      path.resolve(out),
      run.aspect_ratio as VideoAspect,
      normalizeOutputResolution(run.output_resolution),
      { head: bookends.intros, tail: bookends.outros },
      fps,
    );
    const p = await probeFile(out);
    console.log(
      `[${id}] done in ${Math.round((Date.now() - t0) / 1000)}s: ${p.width}x${p.height} ${p.fps}fps ${p.duration?.toFixed(2)}s ${p.codec}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
