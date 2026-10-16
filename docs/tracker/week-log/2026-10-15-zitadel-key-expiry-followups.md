# 2026-10-15 — Zitadel key-expiry digest follow-ups

**Session type:** Review follow-ups
**Branch:** `fix/PLAT-953-zitadel-key-expiry-followups`
**Issue:** #953 (from the review of #948)

- **Done.** A `SET NX EX` lock (released in `finally`) around the decide-and-send step, so the daily and
  on-start jobs cannot both email; `attempts: 3` with exponential backoff on both jobs (safe, the last-digest
  key is written only after a successful send); justification comment on the `JSON.parse` cast in telemetry;
  CHANGELOG entry for `OPS_ALERT_EMAIL` and the daily email.
- **Verified.** Unit tests for concurrent runs, lock release after a failed send and the retry options;
  mutation check confirmed the concurrency test needs the lock.
- **Review round (R1, R2).** The lock now stores a random token and is released by compare-and-delete (same
  script as `retention-archival.ts`), so a send that outlives the 300 s TTL cannot delete the lock a later run
  took. The test mock honours the token, with a takeover test and a token-shape test; a mutation that releases
  by the wrong token fails the lock tests.
- **Deferred.** The lock has a fixed TTL with no renewal, so a send slower than 300 s can still overlap with a
  second run, and the worst case is a duplicate email (the fingerprint is written only after a send).
