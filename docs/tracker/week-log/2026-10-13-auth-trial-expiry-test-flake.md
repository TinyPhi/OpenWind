# 2026-10-13 — Flaky trial-expiry unit test in @platform/auth (#873)

**Session type:** Code
**Branch:** `fix/PLAT-873-auth-trial-expiry-flake`

- A loop of 8 full `pnpm test` runs on fresh databases failed once, in `packages/auth/src/middleware.test.ts` > "checks expiry fresh on every request": the test set `trialEndsAt` 50 ms ahead and expected the first request to pass, which fails when the request takes longer than 50 ms under parallel load (`expected 403 to be 200`).
- The test now fakes only `Date` and advances it with `setSystemTime`, so it no longer depends on wall-clock timing. It still fails if the expiry result were cached (checked by mutation).
- No `admin-ui` failure was seen in the 8 runs, and the two outbox-poller isolation tests passed 40 of 40 when run together (15 idle, 25 under CPU load). #873's other two groups are therefore still unexplained and stay open.
