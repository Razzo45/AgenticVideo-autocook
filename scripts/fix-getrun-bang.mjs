import fs from "node:fs";

for (const f of [
  "src/pipeline/audioPipeline.ts",
  "src/pipeline/orchestrator.ts",
  "src/pipeline/docPipeline.ts",
  "src/pipeline/poc.ts",
]) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;
  s = s.replace(/await getRun\(([^)]+)\)!/g, "(await getRun($1))!");
  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log("fixed", f);
  }
}
console.log("done");
