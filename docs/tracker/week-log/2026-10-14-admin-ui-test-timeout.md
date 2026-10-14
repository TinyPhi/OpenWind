# 2026-10-14 — admin-ui test timeout for the parallel run (#873)

**Session type:** Code
**Branch:** `fix/PLAT-873-admin-ui-test-timeout`

- #873 group 1: `@platform/admin-ui` tests intermittently fail only inside the full parallel `pnpm test`. Two consecutive failing runs on 2026-10-14 were both `Test timed out in 5000ms` (not assertions): `workflow-records.test.tsx` "Clear all", then `workflow-records-origin-filter.test.tsx` "External". Each file passes alone. The slowest admin-ui test takes about 0.55s unloaded (853 tests, none over 1s), so a failure at 5s means roughly a 10x slowdown.
- `apps/admin-ui/vitest.config.ts` now sets `testTimeout: 15_000`, about 30x the slowest unloaded test, so a real hang still fails. No test was changed.
- Limits of the evidence: I could not reproduce the slowdown by CPU stress alone (16 and 40 busy processes, load average up to 63, all passed), so the cause is probably a mix of memory, IO and the many concurrent suites rather than raw CPU. This is a mitigation matching the observed signature, not a proven root cause. Group 2 (the outbox-poller isolation test) is unexplained and untouched.
