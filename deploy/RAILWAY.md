# Railway split deploy (web + worker)

GDP-style: two services, shared Postgres + object storage, Gemini Files URI reuse.

## Services

| Service | Dockerfile | Role |
|---------|------------|------|
| **web** | `Dockerfile.web` | Next.js UI + `/api/cook` enqueue |
| **worker** | `Dockerfile.worker` | Job claim + Omni/image/Argon + hygiene |

Keep the legacy `Dockerfile` + `deploy/start.sh` only for single-box smoke tests.

## Env (both services)

- `GEMINI_API_KEY` — required
- `AUTH_MODE=strict` — required on Railway (no anonymous UI)
- `AUTOCOOK_JWT_SECRET` — HS256 secret for launch/session JWTs
- `AUTOCOOK_SERVICE_TOKEN` — shared bearer for mother → Autocook service calls
- `DATABASE_URL` — Postgres (leases + runs/jobs). Schema files `sql/001` through `sql/004` apply on web and worker boot.
- Auth contract: `docs/auth-contract.md`
- `S3_*` / `STORAGE_S3_*` — prefer Railway bucket refs so the canvas links:
  - `S3_BUCKET=${{autocook.BUCKET}}`
  - `S3_ENDPOINT=${{autocook.ENDPOINT}}`
  - `S3_REGION=${{autocook.REGION}}`
  - `S3_ACCESS_KEY_ID=${{autocook.ACCESS_KEY_ID}}`
  - `S3_SECRET_ACCESS_KEY=${{autocook.SECRET_ACCESS_KEY}}`
- `S3_FORCE_PATH_STYLE=0` — Railway buckets use virtual-hosted URLs (set `1` only for path-style providers)
- `RUNS_DIR` — optional local mirror path (default `/app/runs` or `./runs`)
- `GEMINI_CONCURRENCY=2`, `GEMINI_FILES_CONCURRENCY=2`, `GEMINI_OWNER_CONCURRENCY=1`
- `STAGING_IDLE_MS` — default 5h; purge plates/shots after finished + idle
- `RUN_TTL_MS` — default 24h; delete entire run (including download)

## Hygiene

1. **5h** after last interaction on a finished cook → delete staging (`inputs`, `shot_*`, `argon_media`, …); keep `final*` + plan JSON.
2. **24h** after last interaction → delete the whole run (download included) + DB rows.
3. Viewing a run (GET detail) bumps `updated_at` (interaction).

## Gemini staging

Plates / large stills / video refs upload **once per content hash** to the Files API; Omni reuses the URI (GDP pattern). Expired handles are reaped on the worker sweep.

## First boot

```bash
psql "$DATABASE_URL" -f sql/001_railway_gemini.sql
```
