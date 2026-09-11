-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'comment.mention_access_granted',
--     'comment.replied', 'access.granted', 'access.revoked', 'workflow.sla_breached',
--     'system.error', 'automation.notify', 'ticket.alert', 'access.updated',
--     'workflow.transitioned', 'entity.updated', 'entity.due_date_approaching',
--     'access_request.created', 'access_request.updated', 'entity.unassigned'
--   ));

-- Found via a live manual test against a real (non-mocked) database, not CI:
-- packages/automation-engine/src/actions/resolve-oncall.ts inserts a
-- notifications row with type = 'oncall.backup_tagged' for the backup
-- on-call notification (docs/specs/oncall-routing.md T15), but this
-- constraint was never extended for it. Same lesson 0066's comment already
-- documents: a CHECK constraint enum is invisible to a mocked-DB unit test
-- (resolve-oncall.test.ts mocks @platform/db entirely). Worse than a silent
-- dead-letter here, though -- the notification insert runs inside the SAME
-- transaction as the ticket assignment (executor.ts's runAction loop), so
-- the constraint violation rolled back the entire rule execution, silently
-- undoing the auto-assignment and its audit entry too, every time a backup
-- notification was attempted.
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
  'ticket.alert',
  'access.updated',
  'workflow.transitioned',
  'entity.updated',
  'entity.due_date_approaching',
  'access_request.created',
  'access_request.updated',
  'entity.unassigned',
  'oncall.backup_tagged'
));
