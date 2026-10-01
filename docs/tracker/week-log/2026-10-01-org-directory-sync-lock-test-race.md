# 2026-10-01 — org-directory sync lock test race fixed

**Session type:** Flaky test fix (failed CI on #749, unrelated to that PR's hono bump)
**Branch:** `fix/org-directory-sync-lock-test-race`

- `apps/api/tests/isolation/org-directory-sync.isolation.test.ts` > "holds the lock across the
  external fetch gap" started the first sync without awaiting it, then immediately called a
  second sync. Both raced on `pg_try_advisory_lock`. When the second won, the first returned
  `already_running`, so no sync held the lock and every polled attempt returned `completed`.
  On a throwaway CI-equivalent DB, a concurrently started second sync won 21/40 times.
- Fix (test-only): the slow importer signals when `fetchAll` starts. A sync can only reach
  `fetchAll` after acquiring the lock. The test awaits that signal, then makes one second call.
  The polling loop is gone.
- Verified on a fresh throwaway Postgres 16 (CI service config, migrations applied): old test
  failed 9/10 runs, new test passed 10/10. `@platform/api` typecheck and lint are clean.
- Found while investigating: the lock is session-scoped, but the compose stack routes app
  traffic through PgBouncer in transaction mode, so the lock can leak or be granted to two
  callers. Filed as #752 (needs a decision; not changed here).
