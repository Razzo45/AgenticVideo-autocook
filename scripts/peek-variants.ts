import fs from "node:fs";
import { listVariants, getRun } from "../src/db";

const id = "run_51a7fa64";
const run = getRun(id)!;
const vars = listVariants(id);
console.log("variants", vars.length);
for (const v of vars) {
  console.log(
    JSON.stringify({
      kind: v.kind,
      shot: v.shot_index,
      sel: v.selected,
      rej: v.rejected,
      exists: fs.existsSync(v.path),
      promptHead: (v.prompt || "").slice(0, 180),
    }),
  );
}
console.log("assets", run.input_assets_json?.slice(0, 500));
