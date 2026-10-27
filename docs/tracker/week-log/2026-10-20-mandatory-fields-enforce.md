# 2026-10-20 — Mandatory ticket fields PR 2.5: backfill, then enforce by default

**Session type:** feature (docs/specs/mandatory-ticket-fields.md R9, T10)
**Branch:** `feat/mandatory-fields-enforce` (off `main` after #1059 merged on 2026-10-21)

- **Backfill migration.** Fills the four values on every workflow record that lacks them
  (workflow_id set, or its type has an active workflow): title "Untitled ticket #<id prefix>",
  due date created_at + 7 days, remark "Backfilled: no remark was recorded when this ticket was
  created.", severity medium. Never overwrites a value, leaves updated_at and non-workflow
  records alone, and re-running it changes nothing. The header carries the zero-missing check.
  Lands as migration 0154, after #1032's 0153.
- **Dry run.** Run inside a rolled-back transaction on the local test database: it filled 3,686
  leftover records and the check query then returned 0.
- **Enforce.** `MANDATORY_FIELDS_MODE` defaults to "enforce" (env schema, `.env.example`);
  "log" stays as an emergency switch.
- **Rollout.** Check the server logs for "mandatory-fields:" warnings first; `db:migrate` runs
  the backfill; a server `.env` that still sets `log` must be changed.
- **Tests.** Isolation test runs the migration's SQL on a fresh tenant: defaults, untouched
  complete and non-workflow records, zero-missing check, idempotent re-run. Env default test.
