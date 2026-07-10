## 2026-07-10 — Security audit finding #4: Zitadel error-body logging

### Done

- `apps/api/src/lib/zitadel-management.ts`: removed `body: result.text` from
  the three failure-path log calls that had it — token exchange
  (`getAccessToken`), list project roles (`listProjectRoles`), and list org
  users (`_fetchOrgUsers`). Each now logs `{ status: result.status }` only,
  with a comment explaining why the raw body is never logged.

### Why

Fourth item from the 2026-07-09 security audit. These three sites logged the
raw Zitadel HTTP response body verbatim on any non-2xx response — an unvetted
external payload that could carry provider-specific diagnostic detail (or
worse) into structured logs readable by anyone with log-aggregator access. An
earlier "pre-pr-security-review" pass had already fixed the happy-path body
logging in this file; these three failure-path spots were the ones it missed.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run, clean)
- pnpm test: PASS — same established 12-test baseline in `@platform/api`, no
  regressions. No new automated test added for this specific change: exercising
  these three branches requires a full mocked crypto (RSA/EC key pair for JWT
  signing) + `node:http`/`node:https` request/response cycle, disproportionate
  effort for a one-line-per-site logging-hygiene fix. Verified instead by
  direct diff review (each site is a mechanical `{status, body} → {status}`
  change, trivial to eye-check) plus confirming the existing test suite for
  this file still passes unchanged.
- pnpm test:isolation: PASS (119/119, cache-hit — outside this change's
  dependency graph)

### Next

Remaining items from the 2026-07-09 security audit's to-do list, in order:
1. **#5** Tenant-status cache cross-instance invalidation.
2. **#6/#7** Defense-in-depth: `automation-rules` routes via `withTenantContext`;
   `entity-types` mutation statements missing a belt-and-suspenders tenant filter.
3. **#8/#9/#10** Introspection cache hash, `users.ts` PII-exposure design
   confirmation, follow-up audit pass on ~90 unreviewed route files.

### Open questions

- None blocking.
