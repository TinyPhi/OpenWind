# 2026-10-09 — advisory locks behind PgBouncer (#752)

**Session type:** Bug fix
**Spec:** `docs/specs/advisory-lock-direct-connection.md`
**Branch:** `fix/PLAT-752-advisory-lock-direct-connection`

- Reproduced against the local stack before changing anything: through PgBouncer (:6432, transaction
  mode) 40 of 40 iterations double-granted the same key, because both reserved connections landed on
  one backend and advisory locks are re-entrant per session. Direct to Postgres: 0 of 40. This is
  worse than the issue text: on a quiet system the lock gave no mutual exclusion at all. Affected:
  org-directory sync, sandbox reset (worker lock and API pre-check), and #838's delete when it lands.
- Fix: new optional `DATABASE_DIRECT_URL` and `DATABASE_LOCK_POOL_MAX` (`@platform/config`). The lock
  logic moved to `packages/db/src/advisory-lock.ts` (public signature unchanged); `client.ts` builds a
  dedicated lock pool lazily, or reuses the main client when the URL is unset. `reserve()` waits at most
  5 s for a pool slot and releases a connection that arrives late. Acquire and release now read
  `pg_backend_pid()` and check the unlock result, and log `advisory lock anomaly` on a mismatch.
- Rejected alternatives: a second PgBouncer in session mode (extra container, no benefit), a
  transaction-scoped lock (cannot span the external fetch), a lease row (the row-based lock was
  replaced after a security review found stale-reclaim could steal a healthy lock).
- Tests: 12 unit tests over a fake Postgres (exclusion, release, anomaly logging, bounded reserve,
  late-arrival release); an opt-in `ADVISORY_LOCK_TEST_URL` integration test (exclusion, crash
  safety) that passes against :5432 and fails against :6432 with `expected true to be false`; config
  tests. CI cannot put PgBouncer in front (`.github/workflows` is off-limits), so the integration
  test stays local.
- R7, through the real function with `DATABASE_URL` still on PgBouncer: `DATABASE_DIRECT_URL` unset
  gave 40/40 double-grants; set, 0 double-grants and 40/40 second holders refused.
- Deferred: a lock-pool counter metric (needs a telemetry dependency edge from `@platform/db`), a CI
  job with PgBouncer in front, and hosted-provider guidance for `DATABASE_DIRECT_URL`.

## Review follow-up (2026-10-10)

- Added `server.deps.inline` for `@platform/*` to `packages/db/vitest.config.ts`, matching sibling packages.
- Log `advisory lock pool created` (with `max`, no URL) on first lock-pool creation; covered in `client.test.ts`.
- Moved the spec to Implemented in `docs/specs/README.md`; documented `DATABASE_LOCK_POOL_MAX` and `ADVISORY_LOCK_TEST_URL` in `docs/local-setup.md`.
- Not changed: the suggested `result?.unlocked` in `release()`. `switchedBackend` is already true when the unlock returns no row, so `!result.unlocked` is never evaluated then, and eslint `no-unnecessary-condition` rejects the optional chain.
