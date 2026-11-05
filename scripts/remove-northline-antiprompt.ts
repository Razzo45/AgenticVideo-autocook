import { loadAntiPrompts, removeAntiPromptSession } from "../src/pipeline/antiprompt";
import { getRun } from "../src/db";

const sid = "auto-sess_ecom_northline-pm-platform-walkthrough-ai";
const before = loadAntiPrompts().filter((r) => r.session_id === sid).length;
removeAntiPromptSession(sid);
const after = loadAntiPrompts().filter((r) => r.session_id === sid).length;
console.log(JSON.stringify({ sid, before, after, totalNow: loadAntiPrompts().length }, null, 2));
const r = getRun("run_04c53bd2");
console.log(
  JSON.stringify(
    { omni: { status: r?.status, error: r?.error, gate: r?.gate, model: r?.video_model } },
    null,
    2,
  ),
);
