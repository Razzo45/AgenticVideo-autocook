# Autocook auth contract (mother platform)

Autocook does **not** ship email/password login. Identity comes from the mother platform (or local mint for testing).

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
  "tenant_id": "optional",
  "kind": "launch"
}
```

Mint locally:

```bash
node scripts/mint-launch-token.mjs --user u_test
curl -X POST "$BASE/api/auth/launch" -H "content-type: application/json" -d "{\"token\":\"$TOKEN\"}"
```

## Ownership

Every run stores `user_id`, `tenant_id`, `created_by_kind`. List/get/delete/actions are scoped to the authenticated user. Workers claim jobs without cookies (queue is shared; ACL is on user-facing reads).

## Idempotency

`requestId` on `POST /api/cook` is unique **per user** (`cook_requests` PK = `(request_id, user_id)`).
