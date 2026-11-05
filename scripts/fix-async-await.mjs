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

const fns = [
  "listVariants",
  "listRuns",
  "listRunsForApi",
  "listAssets",
  "listWaitingRuns",
  "getRun",
  "getVariant",
  "getReview",
];

for (const f of [...walk("src"), ...walk("app")]) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;

  // Fix await foo(...).method → (await foo(...)).method
  for (const n of fns) {
    const re = new RegExp(`await ${n}\\(([^;\\n]*?)\\)\\.(\\w+)`, "g");
    s = s.replace(re, `(await ${n}($1)).$2`);
  }

  // export function X → export async function X when body has await and not already async
  // Rough line-based: if a function signature line doesn't say async but following block until next export has await
  s = s.replace(/^export function (\w+)/gm, (match, name, offset) => {
    const rest = s.slice(offset);
    const nextExport = rest.search(/\nexport /);
    const body = nextExport >= 0 ? rest.slice(0, nextExport) : rest.slice(0, 8000);
    if (/\bawait\b/.test(body) && !match.includes("async")) {
      return `export async function ${name}`;
    }
    return match;
  });

  s = s.replace(/^function (\w+)/gm, (match, name, offset) => {
    const rest = s.slice(offset);
    const nextFn = rest.search(/\n(export )?function |\nexport async function |\nasync function /);
    const body = nextFn >= 0 ? rest.slice(0, nextFn) : rest.slice(0, 4000);
    if (/\bawait\b/.test(body) && !match.includes("async")) {
      return `async function ${name}`;
    }
    return match;
  });

  if (s !== before) {
    fs.writeFileSync(f, s);
    console.log("fixed", f);
  }
}
console.log("done");
