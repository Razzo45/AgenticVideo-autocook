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
  // prepareRunInputsasync (x → prepareRunInputs(async (x
  s = s.replace(/\b([A-Za-z_][\w]*)async\s*\(/g, "$1(async (");
  // collapse foo(async (async ( → foo(async (
  s = s.replace(/\(async\s*\(async\s*\(/g, "(async (");
  // remaining (msg) => await → async (msg) => await  (only when args have no nested parens)
  s = s.replace(/(?<!async\s)\(([^()\n]*)\)\s*=>\s*await\b/g, "async ($1) => await");
  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log("fixed", f);
  }
}
console.log("done");
