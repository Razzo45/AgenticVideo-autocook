# Railway split deploy (web + worker)

GDP-style: two services, shared Postgres + object storage, Gemini Files URI reuse.

## Services

| Service | Dockerfile | Role |
|---------|------------|------|
| **web** | `Dockerfile.web` | Next.js UI + `/api/cook` enqueue |
| **worker** | `Dockerfile.worker` | Job claim + Omni/image/brain + hygiene |

Keep the legacy `Dockerfile` + `deploy/start.sh` only for single-box smoke tests.

Web and worker must ship this revision together. New cooks enqueue `task_plan` / `task_execute`. If web deploys first, those jobs sit until the worker catches up. A worker restart fails in-flight running jobs — retry those cooks.

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
- Worker fonts: HTML, PDF and SVG text render with the families installed in `Dockerfile.worker` (Liberation, DejaVu, Noto, Carlito, Caladea, Open Sans, Lato, Roboto). The list is read at runtime and given to the brain
- Local HTML→PDF needs Chrome/Chromium (`CHROMIUM_BIN`); LibreOffice is only used to print a deck
- `PPTX_EMBED_FONTS` — default off; `1` embeds attached .ttf/.otf faces the deck names, as Embedded OpenType (.fntdata)
- `GEMINI_FILES_CONCURRENCY=2`, `GEMINI_OWNER_CONCURRENCY=1`
- `GEMINI_CONCURRENCY=4`, `GEMINI_CONCURRENCY_INITIAL=3` — calls in flight on the one key (brain + image + video + audio). Defaults shown. AIMD halves on a 429.
- `GEMINI_OMNI_CONCURRENCY=2` — video clips in flight
- `TASK_SLICE_CONCURRENCY=3` — planned files of one task written side by side
- `TASK_EXECUTE_CONCURRENCY=2` — tasks generating at the same time across everyone (at most one of them makes video). Worker slots are this plus one for plan reads
- `QUEUE_AGING_MINUTES=2` — every this many minutes of waiting counts as one deliverable unit (weight 10) lighter, so a heavy task is not passed over forever
- `TASK_CACHE` — default on; one Gemini context cache per task holds the attached files for every file, continuation and rebuild. `0` sends the files with every call. `TASK_CACHE_TTL_SEC` (45 min), `TASK_CACHE_MIN_TOKENS` (40000)
- `HYGIENE_INTERVAL_MS` — default 5 min; the sweep runs beside the claim loop
- `BRAIN_STREAM` — default on; brain replies are streamed and partial text survives a dropped connection. `0` goes back to one unary request per call
- `BRAIN_STREAM_TIMEOUT_MS` (20 min per streamed call), `BRAIN_STREAM_IDLE_MS` (4 min of silence after text has started)
- `BRAIN_CALL_TIMEOUT_MS` (12 min, unary mode only), `TTS_TIMEOUT_MS` (5 min), `MUSIC_TIMEOUT_MS` (10 min), `S3_CALL_TIMEOUT_MS` (30 s)
- `STAGING_IDLE_MS` — default 5h; purge plates/shots after finished + idle
- `RUN_TTL_MS` — default 24h; delete entire run (including download)

## Hygiene

1. **5h** after last interaction on a finished cook → delete staging (`inputs`, `shot_*`, `compose_media`, …); keep `final*` + plan JSON.
2. **24h** after last interaction → delete the whole run (download included) + DB rows.
3. Viewing a run (GET detail) bumps `updated_at` (interaction).

## Gemini staging

Plates / large stills / video refs upload **once per content hash** to the Files API; Omni reuses the URI (GDP pattern). Expired handles are reaped on the worker sweep.

## First boot

```bash
psql "$DATABASE_URL" -f sql/001_railway_gemini.sql
```
