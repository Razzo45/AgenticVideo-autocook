import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const which = process.argv[2];
const root = path.join(process.cwd(), "tests");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

const files = walk(root).filter((file) => {
  if (!which || which === "all") return true;
  return file.includes(`${path.sep}${which}${path.sep}`);
});
if (!files.length) {
  console.error(`No tests for ${which ?? "all"}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-isolation=process", "--test-timeout=180000", ...files],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
