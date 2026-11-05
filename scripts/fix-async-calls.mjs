import fs from "node:fs";
import path from "node:path";

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

for (const f of [...walk("src"), ...walk("app")]) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;

  // fn(async ({ → fn({   (options objects wrongly wrapped)
  s = s.replace(/\b([A-Za-z_][\w]*)\(async\s*\(\{/g, "$1({");

  // prepareRunInputs(async (run, async (msg) => await updateRun(...));
  s = s.replace(
    /prepareRunInputs\(async\s*\(run,\s*async\s*\(msg\)\s*=>\s*await\s+updateRun\(run\.id,\s*\{\s*error:\s*msg\s*\}\)\)\)/g,
    "prepareRunInputs(run, async (msg) => { await updateRun(run.id, { error: msg }); })",
  );

  // Generic: prepareRunInputs(async (run, async (msg) => EXPR));
  s = s.replace(
    /prepareRunInputs\(async\s*\(run,\s*async\s*\(msg\)\s*=>\s*await\s+updateRun\(([^)]*)\)\)\)/g,
    "prepareRunInputs(run, async (msg) => { await updateRun($1); })",
  );

  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log("fixed", f);
  }
}
console.log("done");
