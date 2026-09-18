# 2026-08-26 — Third-party API Phase G Hardening, Phase 1 (T1-T5)

Spec: `docs/specs/third-party-api-phase-g-hardening.md` (+ `-tasks.md`)
ADR: ADR-012 (third-party API access to tickets), ADR-013 (unified rate-limiting strategy)
Branch: `feat/third-party-api-phase-g-hardening`

## Done

- **T1** — ADR-013's 3-tier rate limiting wired into the third-party API:
  per-(api-key, acting-person) tier (`apps/api/src/lib/rate-limit-tiers.ts`,
  applied via `requireTicketScope` and directly in `attachments-upload.ts`),
  per-api-key aggregate tier (`enforceApiKeyRateLimit` in
  `packages/auth/src/middleware.ts`), on top of the pre-existing per-tenant
  tier.
- **T2** — per-tenant rate-limit ceiling is now admin-editable: stored as
  `tenants.config.rate_limit_per_min` (JSONB key, not a new column — same
  convention as notification preferences), 5s in-process cache
  (`packages/auth/src/tenant-rate-limit.ts`), new
  `PATCH /admin/tenants/:id/rate-limit` route (superadmin only).
- **T3** — JWT `iat` max-age check added to the third-party acting-person
  token path only (`verifyJwtWithAudience` in `packages/auth/src/jwks.ts`);
  the regular human-login JWT path (`verifyJwt`) is deliberately unaffected.
  Default 15min via `JWT_MAX_TOKEN_AGE_SECONDS`.
- **T4** — PII/sensitivity redaction wired into the third-party
  ticket-detail GET route (`apps/api/src/lib/redact-entity-fields.ts`,
  reusing the existing `redactMetadata`/`buildSensitivityMap` from
  `@platform/workflow-engine`). Confirmed `workflows.ts`'s list route
  returns no field content, so no redaction needed there.
- **T5** — app-level TLS/HTTPS enforcement middleware
  (`apps/api/src/middleware/https-enforcement.ts`), production-only,
  documented as a partial check (no reverse-proxy config exists in-repo to
  verify against).

## Verification

- `pnpm typecheck`: PASS (full workspace)
- `pnpm lint`: PASS (full workspace, `--max-warnings=0`)
- `pnpm test`: PASS for all new/changed unit tests (`packages/auth`,
  `apps/api`) — one pre-existing test (`tenant-org-lookup.test.ts`) fails on
  this machine only because Docker/Postgres/Redis are down for the whole
  session; confirmed by isolating the failure to DB-connection-dependent
  files only, not a regression from this diff.
- `pnpm test:isolation`: not runnable this session (Docker down) — new
  isolation tests (`tenant-rate-limit.isolation.test.ts`,
  `third-party-rate-limit-tiers.isolation.test.ts`,
  `third-party-read-redaction.isolation.test.ts`) are written and load
  correctly (confirmed via a direct vitest run that fails only on the
  Redis/Postgres connection, not on test structure) but not executed
  against a real database.
- `/review`: clean, no correctness findings.
- `/security-review`: no blocking findings. Two informational notes
  accepted as-is: (1) the new admin PATCH route intentionally skips
  `requireIntrospection()` unlike its suspend/reactivate/delete siblings —
  proportional given the route's bounded blast radius (widening/narrowing a
  rate limit, not deleting/suspending a tenant); (2) the isolation test for
  that route doesn't separately exercise the `PLATFORM_ORG_ID` cross-org
  guard, matching every sibling tenant-lifecycle isolation test in this repo
  (none of them test that guard either) — not fixed here to avoid
  introducing a one-off `@platform/config` mock pattern not used elsewhere
  in this test suite.

## Next

- Phase 2 (T6-T7): idempotency-key support (`idempotency_keys` table, RFC
  8785 canonicalization, 30s in-flight lock, 24h result cache).
- Phase 3 (T8-T12): access-log retention sweep + rollup, tenant-purge
  anonymization for `admin_audit_log`, tenant-purge deletion of
  `idempotency_keys`, Phase F residual-risk disclosure confirmation, final
  cross-phase `/security-review`.
- Once Phase 1 PR merges, re-run `pnpm test:isolation` for real against
  Postgres/Redis (blocked this session by Docker being down) before
  considering T1-T5 fully verified end-to-end.
