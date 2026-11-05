import fs from "node:fs";

const src = fs.readFileSync("src/pipeline/orchestrator.ts", "utf8");
const grab = (name: string) => {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name);
};
const ts = require("typescript") as typeof import("typescript");
const js = ts.transpile(`${grab("describeHex")}\n${grab("plainColourNames")}\nmodule.exports = { plainColourNames };`);
const m = { exports: {} as { plainColourNames: (s: string) => string } };
new Function("module", js)(m);

for (const s of [
  "The Haven Property Management logo in white is centered on a solid 'Haven Green' (#244A3A) background.",
  "Centered on a soft blue-grey background (#ECF4F4), the Westbridge Health logo in blue-grey (#91969A).",
  "Title SECURE ACCESS AT WESTBRIDGE in Westbridge Teal (#1F434F) on White (#FFFFFF).",
  "Field Green #0B4F2C accent, Charcoal #1E1E1E body text.",
]) console.log(`${s}\n  -> ${m.exports.plainColourNames(s)}\n`);
