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
