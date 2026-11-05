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
  // (x) => await foo → async (x) => await foo
  s = s.replace(/(?<!async\s)\(([^)]*)\)\s*=>\s*await\b/g, "async ($1) => await");
  // x => await foo
  s = s.replace(/(?<!async\s)(\b[a-zA-Z_][\w]*)\s*=>\s*await\b/g, "async $1 => await");
  // undo async React components named like buttons/pages that shouldn't be async export function Component
  s = s.replace(/export async function (DeleteRunButton|RunGate|BrandMark|Nav|ThemeToggle)\b/g, "export function $1");
  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log("fixed", f);
  }
}
console.log("done");
