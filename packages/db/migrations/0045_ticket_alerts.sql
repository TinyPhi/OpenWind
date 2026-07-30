-- analytics: excluded (personal reminder metadata, low analytics value)
-- down:
--   REVOKE SELECT, INSERT, UPDATE ON ticket_alerts FROM app_user;
--   DROP TABLE IF EXISTS ticket_alerts;

-- Personal per-ticket alerts (docs/specs/ticket-alerts.md). Grant is included in
-- this same migration (0028 forgot it and needed a follow-up fix in 0032 —
-- see 0032_access_requests_grant.sql).
CREATE TABLE ticket_alerts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  instance_id         UUID NOT NULL REFERENCES entity_instances(id),
  created_by          TEXT NOT NULL,
  note                TEXT NOT NULL,
  fire_at             TIMESTAMPTZ NOT NULL,
  scope               TEXT NOT NULL CHECK (scope IN ('me', 'all')),
  recipients_snapshot JSONB,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
  fired_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS — tenant isolation only. Per-user visibility (creator-always,
-- scope='all' gated on ticket access) is enforced app-side via
-- hasEntityReadAccess, not RLS — see docs/specs/ticket-alerts.md §R2.
ALTER TABLE ticket_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_alerts_tenant_isolation ON ticket_alerts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Indexes
CREATE INDEX ticket_alerts_tenant_instance_idx ON ticket_alerts (tenant_id, instance_id);
CREATE INDEX ticket_alerts_tenant_created_by_idx ON ticket_alerts (tenant_id, created_by);

GRANT SELECT, INSERT, UPDATE ON ticket_alerts TO app_user;
