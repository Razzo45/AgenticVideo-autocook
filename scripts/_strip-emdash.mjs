import { DatabaseSync } from "node:sqlite";

function deEm(s) {
  return String(s)
    .replace(/\u2014/g, " - ")
    .replace(/ \- /g, " - ") // normalize
    .replace(/  +/g, " ")
    .replace(/ - -/g, " -");
}

function scrubObj(v) {
  if (typeof v === "string") return deEm(v);
  if (Array.isArray(v)) return v.map(scrubObj);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubObj(val);
    return out;
  }
  return v;
}

const db = new DatabaseSync("runs/pipeline.db");
const rows = db.prepare(`SELECT id, session_id, initial_prompt, script_json FROM runs`).all();
let n = 0;
for (const r of rows) {
  let changed = false;
  let prompt = r.initial_prompt || "";
  if (prompt.includes("\u2014")) {
    prompt = deEm(prompt);
    changed = true;
  }
  let scriptJson = r.script_json;
  if (scriptJson && scriptJson.includes("\u2014")) {
    const script = scrubObj(JSON.parse(scriptJson));
    scriptJson = JSON.stringify(script);
    changed = true;
  }
  if (!changed) continue;
  db.prepare(`UPDATE runs SET initial_prompt=?, script_json=?, updated_at=? WHERE id=?`).run(
    prompt,
    scriptJson,
    new Date().toISOString(),
    r.id,
  );
  n += 1;
  console.log("scrubbed", r.session_id);
}
console.log("runs updated", n);
