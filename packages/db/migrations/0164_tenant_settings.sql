-- ============================================================
-- Migration: 0164_tenant_settings
-- #1158 -- docs/specs/temporal-scheduler.md
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_write" ON "tenant_settings";
-- DROP POLICY IF EXISTS "tenant_read" ON "tenant_settings";
-- ALTER TABLE "tenant_settings" DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS "tenant_settings";
--
-- tenant_settings: per-tenant organization configuration (#1158).
-- One row per tenant (tenant_id is primary key and foreign key to tenants.id).
-- default_timezone: default IANA timezone string (nullable, null falls back to UTC).
-- analytics: excluded (tenant configuration, not business data)

CREATE TABLE "tenant_settings" (
  "tenant_id"        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  "default_timezone" text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_read" ON "tenant_settings"
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "tenant_write" ON "tenant_settings"
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings TO app_user';
  END IF;
END
$$;
