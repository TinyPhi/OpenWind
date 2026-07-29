-- analytics: excluded (operational inbox state, not analytics-relevant)
-- down:
--   ALTER TABLE outbox_events DROP COLUMN IF EXISTS notified_delivered_at;
--   DROP TABLE IF EXISTS notification_recipients;
--   DROP TABLE IF EXISTS notifications;

-- Second, independent delivery-claim column on the existing outbox_events
-- table. apps/worker/src/outbox-poller.ts already claims rows for the
-- automation engine by setting `delivered_at` (a single-consumer claim, not a
-- broadcast). The notification worker (Phase 2) needs to independently
-- consume the same event types without racing that poller for the same row —
-- the exact failure mode outbox-poller.ts's own comments warn about (the
-- workflow.sla_scheduled incident: one poller's claim silently starved
-- another consumer). A second nullable timestamp lets each consumer claim
-- against its own column instead of sharing one.
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS notified_delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS outbox_events_notified_undelivered_idx
  ON outbox_events (notified_delivered_at, created_at);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  type            TEXT NOT NULL CHECK (type IN (
                    'entity.assigned',
                    'comment.mentioned',
                    'access.granted',
                    'access.revoked',
                    'workflow.sla_breached',
                    'system.error'
                  )),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  link            TEXT,
  -- Outbound handoff de-dupe (R16): marked before/around the external call so a
  -- retried job can detect a prior attempt and skip re-sending. Not a delivery
  -- guarantee — just enough to keep our own retries from double-firing.
  outbound_status TEXT NOT NULL DEFAULT 'pending' CHECK (outbound_status IN (
                    'pending', 'attempted', 'sent', 'failed'
                  )),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_recipients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  user_id         TEXT NOT NULL,
  -- NULL = unread. Private per recipient — never exposes another recipient's
  -- read state (R8).
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_isolation ON notifications
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_recipients_tenant_isolation ON notification_recipients
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Indexes
CREATE INDEX notifications_tenant_idx ON notifications (tenant_id);
-- Keyset pagination (R11): newest-first, stable under concurrent inserts.
CREATE INDEX notifications_tenant_created_idx
  ON notifications (tenant_id, created_at DESC, id DESC);

CREATE INDEX notification_recipients_tenant_idx ON notification_recipients (tenant_id);
-- Primary read path: a user's own inbox, unread-first filtering.
CREATE INDEX notification_recipients_tenant_user_idx
  ON notification_recipients (tenant_id, user_id, read_at);
-- Idempotency (R1): a retried outbox job must not create a duplicate
-- recipient row for the same notification.
CREATE UNIQUE INDEX notification_recipients_notification_user_unique
  ON notification_recipients (notification_id, user_id);

-- app_user grants (see 0019_create_app_user.sql — no ALTER DEFAULT PRIVILEGES
-- in this schema, every tenant-scoped table needs an explicit grant or writes
-- through withTenantContext fail permission-denied).
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications, notification_recipients
  TO app_user;
