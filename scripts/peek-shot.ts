import { getRun } from "../src/db";

const [runId, idx = "6"] = process.argv.slice(2);
const run = getRun(runId);
if (!run?.script_json) throw new Error("no script");
const script = JSON.parse(run.script_json);
const shot = script.shots[Number(idx)];
console.log(JSON.stringify(shot, null, 2));
