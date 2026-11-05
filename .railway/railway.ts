import { bucket, defineRailway, postgres, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "iad" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "iad",
    sizeMB: 50000,
  });
  const autocook = bucket("autocook", { region: "ams" });

  // Variables are unmanaged in Railway (CLI/scripts own them), but document the
  // bucket + Postgres wiring that draws canvas edges:
  //   DATABASE_URL=${{Postgres.DATABASE_URL}}
  //   S3_BUCKET=${{autocook.BUCKET}}
  //   S3_ENDPOINT=${{autocook.ENDPOINT}}
  //   S3_REGION=${{autocook.REGION}}
  //   S3_ACCESS_KEY_ID=${{autocook.ACCESS_KEY_ID}}
  //   S3_SECRET_ACCESS_KEY=${{autocook.SECRET_ACCESS_KEY}}
  //   (+ STORAGE_S3_* mirrors)
  const web = service("web", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile.web" },
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: { iad: 1 },
    deploy: { restartPolicyMaxRetries: 5 },
  });
  const worker = service("worker", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile.worker" },
    replicas: { iad: 1 },
    deploy: { restartPolicyMaxRetries: 10 },
  });

  return project("AI-Output-Generator", {
    variables: { managed: false },
    resources: [web, Postgres, worker, postgresVolume, autocook],
  });
});
