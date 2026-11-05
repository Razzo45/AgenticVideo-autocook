import fs from "node:fs";

const ds = "dataset/agentic_poc";
const lines = fs.readFileSync(`${ds}/meta/meta.jsonl`, "utf8").trim().split(/\n/).map(JSON.parse);
const session = lines[0].session_id;
fs.copyFileSync("config/aigc-meta.schema.json", `${ds}/meta/aigc-meta.schema.json`);
const doc = {
  $schema: "./aigc-meta.schema.json",
  dataset_name: "agentic_poc",
  session_id: session,
  records: lines,
};
fs.writeFileSync(`${ds}/meta/${session}.json`, JSON.stringify(doc, null, 2) + "\n");
console.log("pretty", session, lines.length);
