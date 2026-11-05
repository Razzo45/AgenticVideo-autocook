import { getRun } from "../src/db";
import { parseRunInputs } from "../src/pipeline/inputs";
import { operatorModelImageRefs } from "../src/pipeline/inputs";

const run = getRun("run_f2c457c0")!;
const assets = parseRunInputs(run.input_assets_json);
console.log(
  "assets",
  assets.map((a) => `${a.kind}:${a.filename}`),
);
console.log("model image refs", operatorModelImageRefs(run.input_assets_json));
