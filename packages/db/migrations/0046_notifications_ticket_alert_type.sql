-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'comment.mention_access_granted',
--     'comment.replied', 'access.granted', 'access.revoked', 'workflow.sla_breached',
--     'system.error', 'automation.notify'
--   ));

-- Adds 'ticket.alert' — fired by apps/worker/src/alert-worker.ts when a
-- personal ticket alert (docs/specs/ticket-alerts.md) reaches its fire_at.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'entity.assigned',
  'comment.mentioned',
  'comment.mention_access_granted',
  'comment.replied',
  'access.granted',
  'access.revoked',
  'workflow.sla_breached',
  'system.error',
  'automation.notify',
  'ticket.alert'
));
