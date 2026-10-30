## 2026-10-31 — #1078: cross-tenant worker sweeps run per tenant under RLS

### Done

- `connector-poll-scheduler`, `attachment-cleanup` and `file-cleanup` now enumerate non-deleted
  tenants (the `tenants` table has no RLS) and run each tenant's work inside `withTenantContext`
  with explicit `tenant_id` filters. No new DB role; `app_user` grants unchanged.
- New `apps/worker/src/tenant-sweep.ts`: `listSweepTenants`, `forEachTenant` (per-tenant failure is
  logged with `tenantId` and a typed `TenantSweepError` code, then the sweep continues).
- `connector-poll-scheduler`: a tenant whose installation lookup failed keeps its existing
  repeatable jobs for that tick (no teardown on a transient error); trial-expired tenants are
  skipped (same rule as the other sweeps).
- `attachment-cleanup`/`file-cleanup` export `runCleanup` for direct testing; the per-slot expire is
  now one per-tenant `UPDATE ... RETURNING` inside the tenant transaction.
- Tests: unit tests rewritten for the per-tenant shape; new
  `apps/worker/tests/isolation/cross-tenant-sweeps.isolation.test.ts` runs all three sweeps on a
  pool whose session role is the NOBYPASSRLS `app_user`, over two tenants, and fails on the old code.

### Verification

- pnpm typecheck: PASS (52/52)
- pnpm lint: PASS (52/52)
- pnpm test: PASS except admin-ui `language.test.ts` and `platform-admin-mfa-session.test.ts`
  (fail on main locally too)
- pnpm test:isolation: PASS (worker 101, api 1125)

### Next

- `access-log-retention.ts` has the same flaw (raw cross-tenant CTE on RLS tables as `app_user`;
  its comment wrongly says it runs under a privileged connection). Not fixed here; follow-up.
