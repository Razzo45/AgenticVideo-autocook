/**
 * Print the cook queue, one grep-friendly line per active task.
 *
 *   npm run queue
 *   npm run queue -- run_e5a063de
 *   npm run queue -- --local
 *
 * Production: put AUTOCOOK_SERVICE_TOKEN in .env (same value Railway already has).
 * The command calls GET /api/queue. It does not print the token.
 */
import fs from "node:fs";
import { formatQueueLines, type QueueSnapshot } from "../src/pipeline/queueStatus";

const PRODUCTION = "https://web-production-94c5b.up.railway.app";

function loadEnvFile(): void {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function printLines(lines: string[]): void {
  const filter = process.argv.find((arg) => arg.startsWith("run_"));
  for (const line of lines) {
    if (!filter || line.startsWith("queue ") || line.includes(filter)) console.log(line);
  }
}

async function fromHttp(base: string, token: string): Promise<boolean> {
  const res = await fetch(`${base}/api/queue`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    console.error(`queue route is not deployed at ${base} yet`);
    return false;
  }
  if (!res.ok) {
    console.error(`queue http ${res.status}`);
    return false;
  }
  const body = (await res.json()) as QueueSnapshot & { lines?: string[] };
  printLines(body.lines?.length ? body.lines : formatQueueLines(body));
  return true;
}

async function fromLocal(): Promise<void> {
  delete process.env.DATABASE_URL;
  const { queueSnapshot } = await import("../src/db/index");
  const snapshot = await queueSnapshot();
  printLines(formatQueueLines(snapshot));
}

async function main(): Promise<void> {
  loadEnvFile();
  const local = process.argv.includes("--local");
  const token = process.env.AUTOCOOK_SERVICE_TOKEN?.trim() || "";
  const base = (process.env.AUTOCOOK_BASE_URL || PRODUCTION).replace(/\/$/, "");

  if (!local && token) {
    const ok = await fromHttp(base, token);
    if (!ok) process.exit(2);
    return;
  }
  if (!local) console.error("local queue. Set AUTOCOOK_SERVICE_TOKEN in .env to read production.");
  await fromLocal();
}

void main();
