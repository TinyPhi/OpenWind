# 2026-10-15 — outbox-poller isolation test race (#873 group 2)

**Session type:** Flaky test
**Branch:** `fix/PLAT-873-serialize-outbox-poller-tests`
**Issue:** #873 (group 2)

- **Cause.** `outbox-poller-automation-dedup-race` and `outbox-poller-automation-exclusion` each start the
  real outbox poller, which is deliberately cross-tenant and claims any tenant's undelivered rows. Vitest
  runs the two files in parallel worker processes against one database, so one file's poller can claim the
  other file's row. The claim sets `delivered_at` but the enqueue lands in the other process's mock, so the
  claimed row's job is never seen (`expected undefined to be defined`).
- **Evidence.** With a second poller process running beside the dedup test it failed 5 of 5; without one it
  passed 15 of 15 (two files together) on a fresh database.
- **Fix.** `apps/worker/vitest.config.ts` splits the suite into two projects: every other file as before, and
  the two poller files in an `outbox-poller` project with `fileParallelism: false`. Worker test file count is
  58 before and after.
- **Not changed.** The poller itself. #873 group 1 (admin-ui timeouts) was fixed separately.
