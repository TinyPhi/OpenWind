-- analytics: excluded (internal platform-config flag, not tenant/customer data)
-- down:
--   DROP TABLE IF EXISTS platform_settings;

-- Single-row global settings table. Not tenant-scoped (no tenant_id, no RLS
-- policy) — deliberately a platform-operator concern like modules.is_visible
-- (0040_module_visibility.sql), not a per-tenant setting. The id=1 CHECK
-- enforces there is ever only one row; app code always reads/writes id=1.
--
-- outbound_notifications_enabled: kill switch for the notification outbound
-- handoff (email/SMS/WhatsApp via the external delivery service — currently
-- unreliable/not live). When false, apps/worker and packages/automation-engine
-- skip enqueueing new notify-outbound jobs; in-app notification delivery
-- (DB row + websocket push) is unaffected either way. Defaults to true so
-- existing behavior is unchanged until an admin explicitly flips it off.
CREATE TABLE platform_settings (
  id                              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  outbound_notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                      TEXT
);

INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE platform_settings IS
  'Single-row global platform config. No tenant_id/RLS — deliberately not tenant-scoped.';

-- app_user grants (see 0019_create_app_user.sql — no ALTER DEFAULT PRIVILEGES
-- in this schema, every table needs an explicit grant or writes through
-- withTenantContext/executeRawInTenantContext fail permission-denied).
GRANT SELECT, UPDATE ON platform_settings TO app_user;
