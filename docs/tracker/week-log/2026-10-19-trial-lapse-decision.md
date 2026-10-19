# 2026-10-19 — Expired sandbox trial: decision recorded (#996)

**Session type:** Decision plus a small observability fix
**Branch:** `fix/PLAT-996-trial-lapse-decision`
**Issue:** #996 (found in the independent review of #991)

- **Decision.** #996 asked whether "an expired trial drops background work" is intended. It is: R6 of
  `docs/specs/multi-org-sandbox.md` says background jobs "no-op" past expiry, and R6a says an extension makes
  "login and background work resume with no other step". Nothing was to be replayed. The spec now says so
  explicitly, with what that means in practice (a queued antivirus scan stays `pending`, a queued export or
  notification stays undone, and nothing new is queued during a lapse because the API refuses requests).
- **Schedule rules are the exception.** The tick leaves a rule of an ended trial untouched, so it is long overdue on
  reactivation and goes through its normal catch-up policy (ADR-017), capped by `SCHEDULE_CATCH_UP_MAX` (default 24).
  The burst the review worried about is bounded, and `catch_up: false` rules write audited skip rows. The spec records
  both, including that a long-expired sandbox with `catch_up: true` rules can receive up to the cap per rule at once.
- **Changed.** The tick summary counts rules skipped because their tenant is ineligible as `skippedIneligible`,
  separate from `skipped` (missed fires dropped by catch-up), so a lapsed sandbox is visible without an audit row
  per tick.
- **Verified.** A tick test asserts the split (`skippedIneligible: 2`, `skipped: 0`); it fails with the old counting
  and passes now. Tick suite 25/25.
- **Not changed.** `validateActiveTenant` still logs one warning per ineligible tenant per tick (every 60 s by
  default); it is shared by about 14 workers, so changing its level is a wider decision. A due-rules query that has
  no limit is unchanged. Only sandbox tenants have a trial end, so non-sandbox tenants are unaffected.
