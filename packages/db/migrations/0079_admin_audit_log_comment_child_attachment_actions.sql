-- analytics: excluded (no new table — CHECK constraint update only)
--
-- ADR-012 Phase F, spec AC4: comments.ts, children.ts, and
-- attachments-reference.ts previously wrote NO admin_audit_log entries at
-- all (allowed or denied) -- discovered while implementing the Phase F
-- Access Logs screen, whose R1/R3 acceptance criteria assumed this data
-- already existed for every Phase B-E route. Retrofits all three onto the
-- same atomic allowed/denied audit-write pattern transitions.ts (Phase E)
-- already established. 6 new actions added to @platform/audit's
-- AuditAction TS union in the same commit -- extended proactively here per
-- the Phase C B1 incident's self-imposed rule.
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
--       'tag.resolution_failed', 'tag.misuse_rate_capped',
--       'transition.executed', 'transition.access_denied'
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
    'transition.executed', 'transition.access_denied',
    'comment.created', 'comment.access_denied',
    'child.created', 'child.access_denied',
    'attachment.referenced', 'attachment.reference_denied'
  ));
