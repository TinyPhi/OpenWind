# 2026-10-19 — Launch-safe defaults: body limit, operator fence, TRUST_PROXY (#1012, #1014, #1015)

**Branch:** `feat/PLAT-launch-safe-defaults-body-limit-fence`

- **Filed.** Seven launch-readiness gaps verified on main: #1012 (S6 body limit), #1013 (R1 Redis
  eviction), #1014 (S10 TRUST_PROXY), #1015 (S2 operator fence), #1016 (R5 images), #1018 (S1
  NODE_ENV, mostly mitigated by the prod compose) and #1019 (R7 write-path load test).
- **Done (#1012).** `requestBodyLimit` caps request bodies at `API_BODY_LIMIT_BYTES` (default 2 MiB),
  and `multipart/form-data` / `application/octet-stream` bodies sent to the two upload routes (`POST /files`, `PUT /api/v1/attachments/:id/upload`) at 105 MiB. The larger cap is tied to the route, not just the content type, so a caller cannot buy it elsewhere (the webhook handler reads its body whatever the content type). Over the limit: `413
PAYLOAD_TOO_LARGE`, checked against Content-Length and the received bytes. It sits after the rate
  limiter.
- **Done (#1015).** In production with `PLATFORM_ORG_ID` unset, every `/admin/tenants` route and `/admin/platform-settings` (which flips the global notification kill-switch and had no operator check at all) refuses every caller (404); with it set, only that org's callers pass. Dev and test are unchanged. The issue said any tenant admin; the routes need the
  `superadmin` role, so the real exposure was a `superadmin` granted to a customer user.
- **Done (#1014).** `TRUST_PROXY`, `PLATFORM_ORG_ID` and the body limit are documented in
  `docs/deployment-hardening.md` and `.env.example`, with go-live checklist lines. The API logs a
  warning at startup in production when `TRUST_PROXY` is `false` or `PLATFORM_ORG_ID` is unset.
- **Security review.** Two findings fixed: `/admin/platform-settings` lacked the operator fence, and the upload cap was reachable by content type alone.
- **Not done.** #1013 (Redis queue/cache split versus policy), #1016, #1018, #1019 need decisions or
  environments. The 2 MiB default is a judgement: raise `API_BODY_LIMIT_BYTES` if a legitimate JSON
  payload (large bulk create, entity-type import) is refused. Existing production deploys that never
  set `PLATFORM_ORG_ID` lose access to `/admin/tenants` until they do, by design.

## Review round 1 (#1020)

- The reviewer's blocker (platform org refused the rate-limit PATCH in production) does not
  reproduce: the `else if` belonged to the outer `if (env.PLATFORM_ORG_ID)`, so a platform-org
  caller never reached it. The handler is now a single `denied` expression so the two cases read
  separately, and an isolation test proves the platform org gets 200 in production while a
  same-tenant caller gets 404.
- Every fenced route now logs `platform operator fence: access denied` (tenantId, path) before the 404.
- `UPLOAD_BODY_LIMIT_BYTES` is `MAX_FILE_BYTES` (now exported from `@platform/files`) plus 5 MiB.
- `TRUST_PROXY` defaults to `"false"` in the config schema, so the startup guard also covers unset; commented.
