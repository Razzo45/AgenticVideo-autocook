#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8080}"
mkdir -p /app/runs

# Next serves the UI + API; worker drains the SQLite job queue (same volume).
npx concurrently -k -n web,worker -c cyan,magenta \
  "npx next start -H 0.0.0.0 -p ${PORT}" \
  "npx tsx src/worker.ts"
