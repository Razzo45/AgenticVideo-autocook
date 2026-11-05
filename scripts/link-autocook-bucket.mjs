/**
 * Wire web/worker S3 + DATABASE_URL to Railway variable references (canvas edges).
 * Uses GraphQL variableUpsert so refs stay as ${{resource.KEY}} (not resolved literals).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT = "f411c8ab-aae4-41cc-b65c-c8bfdb0fbe0d";
const ENV_ID = "8f2d4dbc-9611-4001-98d2-f9271e70212e";
const WEB_ID = "37ffb314-9bac-43b6-adb1-a4fd0e4875cb";
const WORKER_ID = "f7f5bd95-2a33-4d02-a46c-5b358c9ce708";

const S3_KEYS = [
  ["S3_BUCKET", "${{autocook.BUCKET}}"],
  ["S3_ENDPOINT", "${{autocook.ENDPOINT}}"],
  ["S3_REGION", "${{autocook.REGION}}"],
  ["S3_ACCESS_KEY_ID", "${{autocook.ACCESS_KEY_ID}}"],
  ["S3_SECRET_ACCESS_KEY", "${{autocook.SECRET_ACCESS_KEY}}"],
  ["STORAGE_S3_BUCKET", "${{autocook.BUCKET}}"],
  ["STORAGE_S3_ENDPOINT", "${{autocook.ENDPOINT}}"],
  ["STORAGE_S3_REGION", "${{autocook.REGION}}"],
  ["STORAGE_S3_ACCESS_KEY_ID", "${{autocook.ACCESS_KEY_ID}}"],
  ["STORAGE_S3_SECRET_ACCESS_KEY", "${{autocook.SECRET_ACCESS_KEY}}"],
  ["S3_FORCE_PATH_STYLE", "0"],
  ["DATABASE_URL", "${{Postgres.DATABASE_URL}}"],
];

function upsertFields(aliasPrefix, serviceId) {
  return S3_KEYS.map(([name, value], i) => {
    const alias = `${aliasPrefix}${i}`;
    return `${alias}: variableUpsert(
    input: {
      projectId: $projectId
      environmentId: $environmentId
      serviceId: ${serviceId}
      name: ${JSON.stringify(name)}
      value: ${JSON.stringify(value)}
      skipDeploys: true
    }
  )`;
  }).join("\n  ");
}

mkdirSync("tmp", { recursive: true });
const gqlPath = resolve("tmp/link-bucket.graphql");
const varsPath = resolve("tmp/link-bucket.json");
writeFileSync(
  gqlPath,
  `mutation LinkBucket($projectId: String!, $environmentId: String!) {
  ${upsertFields("web", "$webId")}
  ${upsertFields("worker", "$workerId")}
}
`.replaceAll("$webId", WEB_ID).replaceAll("$workerId", WORKER_ID),
);
// serviceId must be GraphQL string literals when inlined — rewrite properly:
writeFileSync(
  gqlPath,
  `mutation LinkBucket($projectId: String!, $environmentId: String!, $webId: String!, $workerId: String!) {
  ${upsertFields("web", "$webId")}
  ${upsertFields("worker", "$workerId")}
}
`,
);
writeFileSync(
  varsPath,
  JSON.stringify({
    projectId: PROJECT,
    environmentId: ENV_ID,
    webId: WEB_ID,
    workerId: WORKER_ID,
  }),
);

const result = spawnSync(
  "npx",
  ["--yes", "@railway/cli@latest", "api", "--file", gqlPath, "--variables", `@${varsPath}`],
  { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] },
);
if (result.status !== 0) {
  throw new Error((result.stderr || result.stdout || "").slice(0, 800));
}
console.log("bucket + postgres refs linked");

