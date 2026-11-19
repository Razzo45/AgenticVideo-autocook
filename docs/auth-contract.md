# Autocook auth contract (mother platform)

Autocook does **not** ship email/password login. Identity comes from the mother platform (or local mint for testing).

A cook is one task. The sign-in token identifies the person. It does not name a deliverable. The cook body is the operator prompt and the files. The brain decides the files.

## Modes

| Mode | Header / cookie | Identity |
|------|-----------------|----------|
| **Service API** | `Authorization: Bearer <AUTOCOOK_SERVICE_TOKEN>` + `X-User-Id` (+ optional `X-Tenant-Id`) | Machine caller acting as a user |
| **Signed launch** | Short-lived HS256 JWT → `POST /api/auth/launch` → httpOnly `autocook_session` cookie | Browser UI |
| **Dev** | `AUTH_MODE=dev` (default locally) | Falls back to `DEV_USER_ID` / `local-dev` |

Railway must use `AUTH_MODE=strict` with `AUTOCOOK_SERVICE_TOKEN` and `AUTOCOOK_JWT_SECRET` set.

## Launch JWT claims

```json
{
  "sub": "user-id-from-mother",
  "aud": "autocook",
  "iat": 0,
  "exp": 0,
  "tenant_id": "optional"
}
```

Do not put a deliverable kind on this token. Older tokens that still include `"kind": "launch"` keep working. That field is ignored.

`POST /api/auth/launch` body is `{ "token": "<jwt>" }`. The response sets `autocook_session` (httpOnly, Secure in production, SameSite=Lax, Path=/, 8h). The session cookie is the same claim shape, with a longer expiry.

Mint locally:

```bash
node scripts/mint-launch-token.mjs --user u_test
curl -X POST "$BASE/api/auth/launch" -H "content-type: application/json" -d "{\"token\":\"$TOKEN\"}"
```

## Cook body

`POST /api/cook` after sign-in. JSON or multipart.

```json
{
  "prompt": "the operator task, unchanged",
  "requestId": "unique-per-user",
  "sessionLabel": "optional",
  "category": "optional"
}
```

Multipart uses the same fields plus one or more `inputs` files. Send the files here. There is no separate upload step and no link field. There is no `kind` field. Sending one does nothing. A task package is not capped at 10 MB. The response includes `taskWeight` and `taskParts`, which are only the queue cost.

Service callers send `Authorization: Bearer <AUTOCOOK_SERVICE_TOKEN>` and `X-User-Id`. Browser callers send the session cookie. No CORS.

## Queue

A cook has two stages.

1. **Plan.** The brain reads the prompt and the files and returns the list of files it will make. In a second turn of the same conversation it writes the decisions every file shares and a brief for each file (`task_plan.json` keeps both). Each file is then written in its own call from those. This is text. It can run while someone else's files are generating.
2. **Deliverables.** That list sets `taskWeight`. The worker makes up to `TASK_EXECUTE_CONCURRENCY` tasks' files at once (default 2), and only one of them may make video. Someone with nothing running goes before someone who already has a task generating. Then lower weight goes first, and waiting counts: every `QUEUE_AGING_MINUTES` (default 2) makes a task one unit lighter. A task already in a later generation stage finishes before the next person starts.

| Deliverable | Weight |
|-------------|--------|
| svg | 5 |
| image, png, html | 10 |
| pdf | 15 |
| pptx, audio | 20 |
| video | 30 |

The brain lists three images: weight 30. The brain lists one video and two images: weight 50, so that task waits behind the image task. The prompt text is not scored. The plan is.

The cook response has `stage: "plan"` and `taskWeight: null` until that plan exists. The run ticker then shows the weight.

## Queue inspection

`GET /api/queue` returns job counts, run counts, and one row per pending or running job. A queued or generating run with no job is included so a stale status line is visible. The body has `lines` for grep. Prompts and file addresses are omitted.

Authorization is `Authorization: Bearer <AUTOCOOK_SERVICE_TOKEN>`. No `X-User-Id`. Local `AUTH_MODE=dev` with no token configured can read the local queue.

```bash
npm run queue
npm run queue -- run_e5a063de
npm run queue -- --local
```

## Ownership

Every run stores `user_id`, `tenant_id`, and `created_by_kind`. `created_by_kind` is who signed in: `service`, `launch`, or `dev`. It is not a deliverable. List/get/delete/actions are scoped to the authenticated user. Workers claim jobs without cookies (queue is shared; ACL is on user-facing reads).

## Idempotency

`requestId` on `POST /api/cook` is unique **per user** (`cook_requests` PK = `(request_id, user_id)`).

### Deliverable notes

Each row of a task's `deliverables` may carry `notes`: things the platform did to that file that the brain did not write — a video prompt cut at the generator's 6000-character limit, a clip made from a still after the generator refused source footage, a music prompt adjusted before sending, a file extension with no encoder, a font family the worker could not draw (not installed and not in the Google Fonts collection), a reply that needed the one rebuild before it could be built, or files a call wrote that were not planned for it and were not delivered. A row with nothing to report has no `notes` field.
