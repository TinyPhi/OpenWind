-- analytics: excluded (no new table — CHECK constraint update only)
--
-- ADR-012 Phase D, spec R5: apps/worker/src/attachment-scan-failure.ts writes
-- 2 new audit actions (attachment.quarantined, attachment.scan_failed) when
-- an AV scan quarantines or fails a file backing a bound third-party
-- attachment. Extending the CHECK constraint in the SAME commit as the
-- AuditAction TS union addition (packages/audit/src/index.ts) is a
-- self-imposed rule from the Phase C B1 incident (0075) -- this is the third
-- time this exact bug class has been named; the schema is fixed before the
-- worker code that depends on it ships, not after.
--
-- Rollback:
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log
--     ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN (
--       'created', 'updated', 'deleted', 'transitioned', 'restored',
--       'purge.completed', 'purge.failed',
--       'tag.resolved_existing_access', 'tag.auto_granted',
--       'tag.access_request_created', 'tag.fallback',
--       'tag.resolution_failed', 'tag.misuse_rate_capped'
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
    'attachment.quarantined', 'attachment.scan_failed'
  ));
