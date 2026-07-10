## 2026-07-10 — Security audit finding #3: JWT audience validation fail-closed

### Done

- `packages/config/src/env.ts`: `ZITADEL_AUDIENCE` schema changed from `z.string()`
  to `z.string().min(1)` — an empty string now fails config validation at boot
  (fail-closed), instead of silently passing through as a falsy value.
- `packages/auth/src/jwks.ts`: `verifyJwt` now always passes `audience:
  env.ZITADEL_AUDIENCE` to `jwtVerify` unconditionally — removed the
  `env.ZITADEL_AUDIENCE ? {...} : {}` conditional that would have skipped
  audience validation entirely if the value were ever empty/falsy at runtime.
- `packages/auth/src/jwks.test.ts`: +2 tests — `verifyJwt` always calls `jwtVerify`
  with the configured audience; returns null (auth rejected) when `jwtVerify`
  rejects (e.g. audience mismatch).

### Why

Third item from the 2026-07-09 security audit. `ZITADEL_AUDIENCE` was already a
required config field (`z.string()`, no default/optional) — so the app already
fails to boot if the var is completely unset, narrower than the audit's initial
"skipped entirely if unset" framing. The real residual gap: `z.string()` alone
still accepts an empty string, which would pass config validation yet still be
falsy in jwks.ts's conditional, silently disabling audience validation at runtime
instead of failing at boot. Fixed both ends: reject empty string at config load,
and stop conditionally skipping the check in code (now provably always enforced,
since the value is guaranteed non-empty).

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run on touched files, clean)
- pnpm test: PASS — `@platform/auth` 26/26 (up from 24, +2 new). Root `@platform/api`
  failures unchanged at the established 12-test baseline.
- pnpm test:isolation: PASS (119/119)

### Next

Remaining items from the 2026-07-09 security audit's to-do list, in order:
1. **#4** Zitadel error-body logging on failure paths (`zitadel-management.ts`).
2. **#5** Tenant-status cache cross-instance invalidation.
3. **#6/#7** Defense-in-depth: `automation-rules` routes via `withTenantContext`;
   `entity-types` mutation statements missing a belt-and-suspenders tenant filter.
4. **#8/#9/#10** Introspection cache hash, `users.ts` PII-exposure design
   confirmation, follow-up audit pass on ~90 unreviewed route files.

### Open questions

- None blocking.
