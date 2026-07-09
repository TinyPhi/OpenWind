## 2026-07-09 — Hardening #124: auth middleware hot-write on every request

### Done

- `packages/auth/src/middleware.ts`: `requireAuth` no longer unconditionally
  `onConflictDoUpdate`s `tenant_users` on every authenticated request. It now does a
  cheap indexed `SELECT` first (inside the same `withTenantContext` transaction) and
  only writes when the row is missing (new user → insert) or the JWT's `email`/
  `displayName` differ from what's stored (profile drift → update). Steady-state
  requests (existing user, unchanged profile) now cost one SELECT instead of a HOT
  row rewrite. Stale comment claiming `onConflictDoNothing` was in use (it wasn't)
  removed and replaced with an accurate one.
- `packages/auth/src/middleware.test.ts`: added `tenant_users sync (#124)` suite —
  covers insert-on-new-user, skip-on-unchanged-profile, and update-on-profile-drift.
  Extended the `withTenantContext`/`@platform/db` mock to run the callback against a
  fake tx supporting `select().from().where().limit()` and
  `insert().values().onConflictDoUpdate()`, and added `and` to the `drizzle-orm` mock.

### Why

Flagged during a load-readiness audit for 30-40 concurrent users: this was a
guaranteed write transaction on every single authenticated API call regardless of
whether anything changed, competing with real work for the same DB connection pool.
Decision (user-approved): keep live profile sync (don't drop it), gate the write
behind a diff check rather than removing it outright.

### Verification

- pnpm typecheck: PASS (41/41 packages)
- pnpm lint: PASS
- pnpm test: PASS for `@platform/auth` (24/24, incl. 3 new). Root `pnpm test` has 15
  pre-existing failures in `apps/api` (get.test.ts, list-workflow-events.test.ts,
  transitions-events.test.ts, modules.test.ts, view-configs.test.ts,
  quarantine-flow.test.ts, upload-flow.test.ts, zitadel-management.test.ts) —
  confirmed identical with this change stashed out (git stash + rerun), so unrelated
  to this fix. Likely stale state in the long-running dev DB container
  (`ow-database`, up 7 days) rather than a fresh test schema.
- pnpm test:isolation: BLOCKED — not by this change. `check-docker-services.ts`
  requires `openbao`, which isn't a running service at all: it's commented out of
  `docker-compose.yml` (pre-existing #128, "OpenBao + MinIO commented out"). This
  blocks isolation tests for anyone on this repo right now, independent of #124.

### Next

Per the to-do list from the load-readiness audit, in order:
1. Load test (k6/autocannon) simulating 30-40 concurrent users incl. a synchronized
   login burst against the 10 req/min `/auth` rate limit — no load test exists yet.
2. Reconcile CLAUDE.md hardening checklist with actual code state: #121 (RLS role)
   and #123 (BullMQ retry/backoff) both appear already implemented in code but are
   still listed unchecked.
3. #128 (OpenBao commented out) — currently blocking `pnpm test:isolation` entirely,
   worth prioritizing since it blocks the isolation-test gate for all future PRs, not
   just this one.
4. Optional: `docker-compose.yml` resource limits (CPU/memory) — not urgent at 30-40
   user scale.

### Open questions

- None blocking. #128 was surfaced but deliberately left out of scope for this PR —
  it's shared infra config, not part of the auth fix.
