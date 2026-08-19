-- analytics: excluded (extends an existing excluded table's check constraint)
-- down:
--   ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
--   ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
--     'entity.assigned', 'comment.mentioned', 'comment.mention_access_granted',
--     'comment.replied', 'access.granted', 'access.revoked', 'workflow.sla_breached',
--     'system.error', 'automation.notify', 'ticket.alert', 'access.updated',
--     'workflow.transitioned', 'entity.updated', 'entity.due_date_approaching',
--     'access_request.created', 'access_request.updated'
--   ));

-- 0060 extended this constraint for 6 of the 7 new notification-hub event
-- types wired into NOTIFICATION_EVENT_TYPES / resolveRecipients /
-- buildNotificationContent, but missed 'entity.unassigned' -- every INSERT
-- for that type passes recipient resolution and template build, then fails
-- silently at the DB layer and lands in dead_letter_events, exactly the same
-- failure mode 0060 fixed for the other 6. Same lesson: a CHECK constraint
-- enum is invisible to a mocked-DB unit test.
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
  'entity.unassigned'
));
