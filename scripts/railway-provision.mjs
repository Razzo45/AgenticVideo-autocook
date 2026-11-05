/**
 * Provision Railway project AI-Output-Generator:
 * - set web/worker env (Postgres refs, bucket, Gemini)
 * - set Dockerfile paths via GraphQL
 * Never prints secret values.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT = "f411c8ab-aae4-41cc-b65c-c8bfdb0fbe0d";
const ENV_ID = "8f2d4dbc-9611-4001-98d2-f9271e70212e";
const WEB_ID = "37ffb314-9bac-43b6-adb1-a4fd0e4875cb";
const WORKER_ID = "f7f5bd95-2a33-4d02-a46c-5b358c9ce708";

function run(args, input) {
  const result = spawnSync("npx", ["--yes", "@railway/cli", ...args], {
    encoding: "utf8",
    shell: true,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status}`).slice(0, 1200));
  }
  return result.stdout;
}

function setVar(service, key, value) {
  const result = spawnSync(
    "npx",
    ["--yes", "@railway/cli", "variable", "set", key, "--stdin", "--service", service, "--skip-deploys"],
    {
      input: String(value),
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`set ${service}.${key}: ${(result.stderr || result.stdout || "").slice(0, 400)}`);
  }
  console.log(`set ${service}.${key}`);
}

function parseJsonLoose(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`No JSON object in: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function loadGeminiKey() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) throw new Error(".env missing GEMINI_API_KEY");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^GEMINI_API_KEY=(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("GEMINI_API_KEY not found in .env");
}

// Link the Railway bucket via variable references (draws canvas edges; rotates with bucket).
const bucketRefs = {
  S3_BUCKET: "${{autocook.BUCKET}}",
  S3_ENDPOINT: "${{autocook.ENDPOINT}}",
  S3_REGION: "${{autocook.REGION}}",
  S3_ACCESS_KEY_ID: "${{autocook.ACCESS_KEY_ID}}",
  S3_SECRET_ACCESS_KEY: "${{autocook.SECRET_ACCESS_KEY}}",
  STORAGE_S3_BUCKET: "${{autocook.BUCKET}}",
  STORAGE_S3_ENDPOINT: "${{autocook.ENDPOINT}}",
  STORAGE_S3_REGION: "${{autocook.REGION}}",
  STORAGE_S3_ACCESS_KEY_ID: "${{autocook.ACCESS_KEY_ID}}",
  STORAGE_S3_SECRET_ACCESS_KEY: "${{autocook.SECRET_ACCESS_KEY}}",
};
console.log("wiring autocook bucket variable references…");

const gemini = loadGeminiKey();

const shared = {
  DATABASE_URL: "${{Postgres.DATABASE_URL}}",
  ...bucketRefs,
  // Railway buckets use virtual-hosted URLs (not path-style).
  S3_FORCE_PATH_STYLE: "0",
  GEMINI_API_KEY: gemini,
  GEMINI_CONCURRENCY: "2",
  GEMINI_CONCURRENCY_FLOOR: "1",
  GEMINI_CONCURRENCY_INITIAL: "1",
  GEMINI_OWNER_CONCURRENCY: "1",
  GEMINI_FILES_CONCURRENCY: "2",
  GEMINI_INCREASE_AFTER: "4",
  RUNS_DIR: "/app/runs",
  STAGING_IDLE_MS: String(5 * 60 * 60 * 1000),
  RUN_TTL_MS: String(24 * 60 * 60 * 1000),
  NODE_ENV: "production",
};

const webOnly = {
  ...shared,
  SERVICE_ROLE: "web",
  PORT: "8080",
  HOSTNAME: "0.0.0.0",
};

const workerOnly = {
  ...shared,
  SERVICE_ROLE: "worker",
};

for (const [k, v] of Object.entries(webOnly)) setVar("web", k, v);
for (const [k, v] of Object.entries(workerOnly)) setVar("worker", k, v);

writeFileSync(
  "tmp/railway-service-update.json",
  JSON.stringify({
    webId: WEB_ID,
    workerId: WORKER_ID,
    environmentId: ENV_ID,
  }),
);

// GraphQL Builder enum has no DOCKERFILE — dockerfilePath alone selects Dockerfile builds.
// Prefer `.railway/railway.ts` (IaC) for long-term service config.
const gql = `mutation WireAutocook($webId: String!, $workerId: String!, $environmentId: String!) {
  web: serviceInstanceUpdate(
    serviceId: $webId
    environmentId: $environmentId
    input: {
      dockerfilePath: "Dockerfile.web"
      restartPolicyType: ON_FAILURE
      restartPolicyMaxRetries: 5
      healthcheckPath: "/api/health"
      healthcheckTimeout: 300
    }
  )
  worker: serviceInstanceUpdate(
    serviceId: $workerId
    environmentId: $environmentId
    input: {
      dockerfilePath: "Dockerfile.worker"
      restartPolicyType: ON_FAILURE
      restartPolicyMaxRetries: 10
    }
  )
}`;
writeFileSync("tmp/railway-service-update.graphql", gql);

console.log("updating service Dockerfiles via API…");
run([
  "api",
  "--file",
  "tmp/railway-service-update.graphql",
  "--variables",
  "@tmp/railway-service-update.json",
]);
console.log("provisioned env + Dockerfiles");
console.log(`project=${PROJECT}`);
