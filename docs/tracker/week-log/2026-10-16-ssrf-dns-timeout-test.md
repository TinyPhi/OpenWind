# 2026-10-16 — Deterministic DNS-timeout test (#873)

**Session type:** Test reliability
**Branch:** `fix/PLAT-873-deterministic-dns-timeout-test`
**Issue:** #873 (evidence added 2026-10-16)

- **Done.** The `connector-sdk` SSRF guard test "blocks when DNS times out" waited on real timers: the guard's own 2 s
  timer plus a leaked 10 s timer from the `dnsTimeout()` helper, under a 10 s test timeout. It failed once in a full
  `pnpm test` that ran next to other heavy local runs, then passed twice alone and in a repeat run. It now uses fake
  timers and a lookup that never answers, so only the guard's timer can end the wait, and the helper is gone.
- **Stronger than before.** The test checks the boundary (still pending at 1999 ms, blocked at 2000 ms) and that the
  logged reason is `dns-timeout`; the old test passed for any DNS failure.
- **Verified.** 21/21, three runs in a row. Mutations all fail fast: the guard's limit changed to 3000 ms, to 1000 ms,
  and the timeout mislabelled as `dns-error`.
- **Not fixed.** Whether the single failure really was this test's real-time dependence is a reasoned guess, not a
  reproduction: it happened once, under load, and does not reproduce. The other flakes recorded in #873 (admin-ui under the
  parallel run, the `ui` test, `audit-action-filter`) are untouched.
