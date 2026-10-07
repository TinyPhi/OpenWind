# 2026-10-07 — Stage 2 gate: Superset erasure (#728) spec and plan

**Session type:** spec + plan (docs only; no source, workflow or ADR edits)
**Branch:** `docs/PLAT-728-superset-gdpr-erasure-spec-pr`

- **Spec.** `docs/specs/superset-gdpr-erasure.md` covers #728: erasing a user's or a tenant's
  personal data from Superset's own database and Redis cache, as a durable job that never blocks or
  rolls back the Postgres erasure. Superset erases its own data through a service-account-only
  endpoint, so the platform gets no Superset database credential. It also traces every other open
  Stage 2 gate issue (#709, #716, #729, #731) to a task, so none is forgotten (§T0).
- **Decided (owner, 2026-10-07).** D1 existing service account, D2 `owsub:<subject>` marker, D3
  optional `SUPERSET_OAUTH_CLIENT_ID` config field, D5 Superset's database stays out of
  `backup.sh`, D8 7-day escalation alert for an erasure that has not completed. The cache is also
  flushed on erasure in Stage 1.
- **Open for Legal / DPO (§Q).** D4 retention of typed SQL and logs, D6 who approves it, D7 data
  fiduciary versus processor. Nothing is built that depends on them.
- **Plan.** `docs/specs/superset-gdpr-erasure-tasks.md`: four phases, a rollback note, and a
  proposed plan-lock that is **not** frozen; it needs a human `approve-plan` before any edit under
  `apps/` or `packages/`.
- **Scope.** An earlier draft added GDPR-article features that no issue asks for and that DPDP does
  not require (restriction, portability, an access export, an erasure ledger, a legal-hold schema,
  retention jobs). They are out of scope and parked in §S0 with where each would go. §D2 maps the
  work to DPDP; counsel confirms the section numbers.
- **Conflict to resolve.** `superset-embedded-dashboarding.md` R12/T8 says Superset's metadata
  database is backed up and `backup.sh` is extended; D5 decided the opposite (task H10).
