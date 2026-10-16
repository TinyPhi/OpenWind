# 2026-10-15 — event-log protection

**Session type:** Security hardening, PR 5 of the hardening program
**Spec:** `docs/specs/event-log-protection.md`
**Branch:** `feat/PLAT-hardening-event-log-grants` (stacked on `feat/PLAT-hardening-retention-classes`, #945)
**Issue:** #777

- **Decision (owner).** Column-level grant plus a maintenance role, not full append-only.
- **Done.** Migration 0147: `app_user` loses table-level UPDATE and DELETE on `workflow_events` and gets
  UPDATE on metadata, actor_id and origin_performer_user_id (per-user erasure redacts the last two; found when the erasure isolation tests failed), with a trigger that allows those two to change only to `[REDACTED]`; new `event_log_maintenance_role` with DELETE, entered through
  `withEventLogMaintenanceContext`. Retention sweep, tenant purge and sandbox reset delete events through it.
- **Also.** Eleven isolation tests cleaned up events through `app_user`; they now use the maintenance context.
- **Verified.** Isolation test as `app_user` and as the maintenance role; re-granting the privileges makes it fail.
- **Noted.** Sandbox reset's other pre-step deletes (`schedule_executions`, `saved_views`) still run on plain
  `db`, the same blind spot #928 fixed for tenant purge. Left alone here.
- **Follow-up (migration 0148).** Trigger limiting which `metadata` keys an UPDATE may change; branch `feat/PLAT-hardening-event-metadata-guard-2`, based on `main` after #961.
- **Found, not fixed.** Deleting the last attachment of a comment fails: `jsonb_agg` over zero rows is NULL, so
  `jsonb_set` returns NULL (`delete-comment-attachment.ts`). It failed on NOT NULL before 0148 and now fails on the
  guard first; wrapping the aggregate in `COALESCE(..., '[]')` fixes it. Out of scope here.
