/**
 * Apply sql/001_railway_gemini.sql using DATABASE_URL from the linked Railway project.
 * Does not print connection strings or secrets.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

function railway(args) {
  const result = spawnSync("npx", ["--yes", "@railway/cli@latest", ...args], {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status}`).slice(0, 800));
  }
  return result.stdout;
}

function extractDatabaseUrl(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL=(.+)$/);
    if (m) return m[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (typeof obj.DATABASE_URL === "string") return obj.DATABASE_URL;
  }
  throw new Error("DATABASE_URL not found in railway variable output");
}

const sqlPath = resolve(process.cwd(), "sql/001_railway_gemini.sql");
const sql = readFileSync(sqlPath, "utf8");
console.log("fetching DATABASE_URL from Railway (web)…");
const raw = railway(["variable", "list", "--service", "web", "--kv"]);
const databaseUrl = extractDatabaseUrl(raw);
console.log("applying", sqlPath.replace(/\\/g, "/").split("/").slice(-2).join("/"), "…");

const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  console.log("sql applied ok");
} finally {
  await client.end();
}
