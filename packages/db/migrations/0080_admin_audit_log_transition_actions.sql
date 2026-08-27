-- analytics: excluded (no new table — CHECK constraint update only)
--
-- ADR-012 Phase E, spec R3: the third-party status-transition route
-- (apps/api/src/routes/third-party/transitions.ts) writes 2 new audit
-- actions -- transition.executed (success) and transition.access_denied
-- (every denied attempt, including a granted-but-not-owner rejection) --
-- added to @platform/audit's AuditAction TS union in the same commit but
-- never added to this table's action CHECK constraint allowlist
-- (0011_admin_audit_log.sql). Extended proactively, in the same commit as
-- the TS union change, per the Phase C B1 incident's self-imposed rule
-- (every unit/isolation test around a route like this mocks @platform/db
-- unless it specifically targets a real Postgres instance, so a forgotten
-- CHECK-constraint update would otherwise ship silently broken).
--
-- Renumbered from 0078 to 0079 (PR #484 review, PrabhuVijit B-01) --
-- PR #475 merged its own 0078_admin_audit_log_attachment_scan_actions.sql
-- first, so this migration's number collided with an already-merged one.
-- Renumbered again from 0079 to 0080 -- PR #488 merged its own
-- 0079_extend_attachments_expiry_idx.sql before this PR did.
--
-- Rollback (PR #484 review, PrabhuVijit B-02 -- the previous version of this
-- rollback restored the constraint to its pre-#475 state, which would have
-- DROPPED 'attachment.quarantined'/'attachment.scan_failed' on a rollback
-- performed after #475 merged -- a rollback must undo only what THIS
-- migration added, leaving everything before it, including sibling
-- migrations merged ahead of it, untouched):
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log
--     ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN (
--       'created', 'updated', 'deleted', 'transitioned', 'restored',
--       'purge.completed', 'purge.failed',
--       'tag.resolved_existing_access', 'tag.auto_granted',
--       'tag.access_request_created', 'tag.fallback',
--       'tag.resolution_failed', 'tag.misuse_rate_capped',
--       'attachment.quarantined', 'attachment.scan_failed'
--     ));

ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;

ALTER TABLE admin_audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'created', 'updated', 'deleted', 'transitioned', 'restored',
    'purge.completed', 'purge.failed',
    'tag.resolved_existing_access', 'tag.auto_granted',
    'tag.access_request_created', 'tag.fallback',
    'tag.resolution_failed', 'tag.misuse_rate_capped',
    'attachment.quarantined', 'attachment.scan_failed',
    'transition.executed', 'transition.access_denied'
  ));
