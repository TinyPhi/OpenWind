-- analytics: excluded (no new table — CHECK constraint update only)
--
-- ADR-012 Phase C, spec R6/R7: mention-resolution-worker.ts writes 6 new
-- audit actions (tag.resolved_existing_access, tag.auto_granted,
-- tag.access_request_created, tag.fallback, tag.resolution_failed,
-- tag.misuse_rate_capped) — added to @platform/audit's AuditAction TS union
-- (packages/audit/src/index.ts) but never added to this table's action
-- CHECK constraint allowlist (0011_admin_audit_log.sql). Every one of those
-- writes has been failing with a CHECK violation since Phase C shipped —
-- found via OWTester functional testing against a real Postgres instance,
-- since every unit/isolation test around this path mocks @platform/db and
-- never exercises the real constraint. Same bug class as
-- 0038_audit_log_purge_actions.sql (purge.completed/purge.failed) — that
-- precedent didn't get generalized into a rule, so it recurred; see the
-- Phase C spec's §V invariants for the promotion.
--
-- Rollback:
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log
--     ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN ('created', 'updated', 'deleted', 'transitioned', 'restored', 'purge.completed', 'purge.failed'));

ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;

ALTER TABLE admin_audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'created', 'updated', 'deleted', 'transitioned', 'restored',
    'purge.completed', 'purge.failed',
    'tag.resolved_existing_access', 'tag.auto_granted',
    'tag.access_request_created', 'tag.fallback',
    'tag.resolution_failed', 'tag.misuse_rate_capped'
  ));
