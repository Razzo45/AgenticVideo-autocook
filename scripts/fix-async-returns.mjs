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

for (const f of [...walk("src")]) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;

  // async function name(...): SomeType {  → Promise<SomeType>
  // Avoid already-Promise and void
  s = s.replace(
    /(export\s+)?async function (\w+)\(([^)]*)\):\s*(?!Promise\b|void\b)([^{;=]+)\s*\{/g,
    (_m, exp = "", name, args, ret) => {
      const r = ret.trim();
      if (r.startsWith("Promise<")) return _m;
      return `${exp}async function ${name}(${args}): Promise<${r}> {`;
    },
  );

  // After `const fresh = await getRun(...)` ensure throw
  s = s.replace(
    /(const fresh = await getRun\([^)]+\);)\n(?!\s*if \(!fresh\))/g,
    "$1\n  if (!fresh) throw new Error(\"Unknown run\");\n",
  );

  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log("fixed", f);
  }
}
console.log("done");
