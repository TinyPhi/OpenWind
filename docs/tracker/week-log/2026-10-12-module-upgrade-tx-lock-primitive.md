# 2026-10-12 — Locked tenant transaction primitive (#673 T2)

**Session type:** Code (spec slice S2)
**Branch:** `feat/PLAT-673-tx-lock-primitive`

- Added `withLockedTenantTransaction` to `@platform/db` (additive; no existing export changed). One
  postgres-js transaction: `pg_try_advisory_xact_lock` first (busy returns `{ acquired: false }` and
  the callback never runs), then `SET LOCAL ROLE app_user` and the tenant GUC, then the callback.
  The callback gets `{ db, exec }`: Drizzle bound to the same transaction, and raw SQL over the
  simple query protocol. `dryRun` forces a ROLLBACK and still returns the callback's value.
  `db.transaction` is disabled (`SavepointNotAllowedError`) so nothing can open a SAVEPOINT.
- **Deviation from the spec's wording:** T2 says "lock, N SQL strings, then a callback". The
  primitive takes one callback instead, with `exec` for the SQL strings. T4 has to re-read
  `applied_version` under the lock, run the files, count `xmin` deltas and write the version row,
  and a single callback lets it interleave those without a second transaction. Same atomicity.
- **Spike (source-driven-development), against drizzle-orm 0.45.2 / postgres 3.4.9, on a real DB:**
  - `drizzle({ client: tx })` throws on a real transaction handle: postgres-js builds it without
    `options`, and drizzle's constructor writes parsers onto `client.options`. Drizzle's own
    `transaction()` avoids this by building its session directly. Fix: share the parent client's
    `options` with the handle. A unit test with a fake handle that had `options` hid this; the
    integration test caught it. Logged as B8 in the spec.
  - postgres-js remembers a failed statement and rethrows it after the callback, so an error
    swallowed inside the callback still aborts and rolls back the transaction.
  - Rows written through `exec` and through Drizzle both have `xmin = pg_current_xact_id()::xid`,
    so counting by `xmin` works, and no SAVEPOINT is involved.
  - The new integration test passes 9/9 on direct Postgres and 9/9 through PgBouncer in
    transaction-pooling mode connecting as `app_user` (the compose topology). It covers lock
    exclusion and release, same-transaction visibility, rollback on failure and on dry run, RLS
    (a row for another tenant is refused), `xmin`, and the SAVEPOINT guard.
- Review (security and correctness lenses, a skeptic per finding): two of eight findings confirmed,
  both low, both fixed. `db` and `exec` kept past the callback would have run on the pool in
  autocommit as the pool's own role, so they now throw `LockedTransactionClosedError`; and
  `db.$client.savepoint` bypassed the SAVEPOINT guard, so the client handle drizzle sees is a proxy
  that refuses `savepoint` and any use after the callback. Rejected, with reasons: `exec` is
  unfiltered raw SQL (same as `executeRawInTenantContext`; T3's allowlist lint is what constrains
  the SQL, and the docstring now says so), the lock key is caller-supplied (T4's contract fixes it
  per spec), and the options sharing only affects clients the package does not export.
- Drizzle wraps driver errors in a `DrizzleQueryError`, so a stale `db` call rejects with the
  closed error as its `cause`; a stale `exec` call rejects with it directly.
- The integration test runs whenever `DATABASE_URL` is set (CI sets it); `LOCKED_TX_TEST_URL`
  points it elsewhere (for example PgBouncer) and `LOCKED_TX_ADMIN_URL` supplies a privileged URL
  for the scratch table when the main one is `app_user`. It skips otherwise.
- Not done here (later slices): the migration, `@platform/module-upgrades`, the worker upgrade
  service and the CLI.
