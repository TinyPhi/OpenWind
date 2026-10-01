## 2026-08-24 — Issue #436: outbox-poller isolation-test flake fixed (test-timeout margin, not a poller bug)

**Session type:** Bug fix / test reliability
**Branch:** `fix/PLAT-436-outbox-poller-isolation-flake`

### Completed this session

#### Issue #436 (`outbox-poller-automation-exclusion`/`-dedup-race` isolation tests time out intermittently)

- Root cause: both tests poll up to 100 iterations × 50ms sleep (5000ms of sleep alone) plus
  1-2 `db.select()` round trips per iteration, against vitest's **default 5000ms per-test
  timeout** — zero margin. Any real per-iteration overhead (backlog from other suites'
  fixtures, since the poller processes oldest-first with `LIMIT 100` per tick; or CPU
  contention from a full `pnpm test` monorepo run) pushes wall clock past the exact 5000ms
  cutoff, producing an opaque `Test timed out` failure with no bug in the poller itself.
- Validated the mechanism empirically before changing any code: inserted ~15,000 synthetic
  backlog rows into `outbox_events` (same shape the test's own comment already anticipated),
  ran the unmodified test, and reliably reproduced the exact reported failure. Re-ran with the
  fix and a backlog size the loop's own 100-attempt bound can still drain — passed cleanly.
- Fix: added an explicit `15_000`ms timeout as the third argument to `it(...)` in both test
  files. No production code changed — `apps/worker/src/outbox-poller.ts` is untouched. The
  loop's own 100-attempt bound is unchanged, so genuine non-delivery still fails with a clear
  assertion, well under 15s, not a slow opaque timeout.
- This closes out the investigation this repo's own `pnpm test`/`pnpm test:isolation` exit
  condition needed: the migration-0073 journal-timestamp bug (PR #476, separate, unrelated
  root cause found while reproducing this issue) is what was masking a clean baseline to flake
  against in the first place.

### Verification

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- `pnpm test` × 3 consecutive runs (fresh DB): PASS, 30/30 tasks each run
- `pnpm test:isolation` × 3 consecutive runs (fresh DB): PASS, 17/17 tasks each run
- `git diff apps/worker/src/outbox-poller.ts`: empty — test-only fix
