/**
 * Kick a real COOK from an original AgenticVideo task pack (raw-prompt + raw/).
 * Usage: npx tsx scripts/cook-from-task.ts <taskDir> [sessionLabel]
 * Env: AGENTIC_BASE_URL (default http://127.0.0.1:3001)
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.AGENTIC_BASE_URL ?? "http://127.0.0.1:3001";

async function main() {
  const taskDir = process.argv[2];
  const sessionLabel = process.argv[3] || path.basename(taskDir || "").replace(/^task-/, "");
  if (!taskDir) throw new Error("usage: cook-from-task.ts <taskDir> [sessionLabel]");

  const root = path.resolve(taskDir);
  const promptPath = path.join(root, "raw-prompt.txt");
  const rawDir = path.join(root, "raw");
  if (!fs.existsSync(promptPath)) throw new Error(`missing ${promptPath}`);
  if (!fs.existsSync(rawDir)) throw new Error(`missing ${rawDir}`);

  const prompt = fs.readFileSync(promptPath, "utf8").trim();
  const files = fs
    .readdirSync(rawDir)
    .map((f) => path.join(rawDir, f))
    .filter((p) => fs.statSync(p).isFile());

  const form = new FormData();
  form.set("prompt", prompt);
  form.set("sessionLabel", sessionLabel);
  form.set("category", "E-commerce & Advertising");
  for (const abs of files) {
    const buf = fs.readFileSync(abs);
    form.append("inputs", new Blob([new Uint8Array(buf)]), path.basename(abs));
    console.log(`[attach] ${path.basename(abs)} (${(buf.length / 1e6).toFixed(2)} MB)`);
  }

  console.log(
    `[cook] POST ${BASE}/api/cook — ${files.length} files, prompt ${prompt.length} chars, label=${sessionLabel}`,
  );
  const res = await fetch(`${BASE}/api/cook`, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 1200)}`);
  const json = JSON.parse(text) as {
    run?: { id: string; session_id: string; status: string };
    preflight?: { status: string };
  };
  console.log(
    JSON.stringify(
      {
        id: json.run?.id,
        session: json.run?.session_id,
        status: json.run?.status,
        preflight: json.preflight?.status,
      },
      null,
      2,
    ),
  );
  console.log(`[open] ${BASE}/runs/${json.run?.id}`);
}

main().catch((err) => {
  console.error("[cook-from-task] FAILED", err);
  process.exit(1);
});
