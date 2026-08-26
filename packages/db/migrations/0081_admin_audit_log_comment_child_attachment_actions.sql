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
-- Renumbered from 0079 to 0080 -- this branch stacked on Phase E's
-- (feat/third-party-api-phase-e-status-transitions) migration, which was
-- itself renumbered 0078 -> 0079 during PR #484 review (PrabhuVijit B-01)
-- after PR #475 merged its own 0078 first.
-- Renumbered again from 0080 to 0081 -- PR #488 merged its own
-- 0079_extend_attachments_expiry_idx.sql, which bumped Phase E's sibling
-- migration from 0079 to 0080, in turn bumping this one to 0081.
--
-- Rollback (undoes only what THIS migration added -- PR #484 review,
-- PrabhuVijit B-02, applied proactively here so this migration doesn't ship
-- the same rollback-drops-sibling-actions bug):
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   ALTER TABLE admin_audit_log
--     ADD CONSTRAINT audit_log_action_check
--     CHECK (action IN (
--       'created', 'updated', 'deleted', 'transitioned', 'restored',
--       'purge.completed', 'purge.failed',
--       'tag.resolved_existing_access', 'tag.auto_granted',
--       'tag.access_request_created', 'tag.fallback',
--       'tag.resolution_failed', 'tag.misuse_rate_capped',
--       'attachment.quarantined', 'attachment.scan_failed',
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
    'attachment.quarantined', 'attachment.scan_failed',
    'transition.executed', 'transition.access_denied',
    'comment.created', 'comment.access_denied',
    'child.created', 'child.access_denied',
    'attachment.referenced', 'attachment.reference_denied'
  ));
