-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'access.granted', 'access.revoked',
--     'workflow.sla_breached', 'system.error'
--   ));

-- Adds 'automation.notify' — tenant-authored automation rules' "notify"
-- action now routes through this same table (packages/automation-engine/src/
-- actions/notify.ts, T10) instead of being a separate, disconnected path.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'entity.assigned',
  'comment.mentioned',
  'access.granted',
  'access.revoked',
  'workflow.sla_breached',
  'system.error',
  'automation.notify'
));
