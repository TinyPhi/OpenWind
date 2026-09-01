-- ============================================================
-- Migration: 0085_tenant_usage_daily
-- ADR-015 Decision #3, issue #505 -- tenant_usage_daily metering
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "tenant_usage_daily_tenant_isolation" ON "tenant_usage_daily";
-- ALTER TABLE "tenant_usage_daily" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "tenant_usage_daily_tenant_date_idx";
-- DROP INDEX IF EXISTS "tenant_usage_daily_tenant_idx";
-- DROP TABLE IF EXISTS "tenant_usage_daily";
--
-- analytics: included (tenant_id, usage_date, metric, value)

CREATE TABLE "tenant_usage_daily" (
  "tenant_id"  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  "usage_date" date NOT NULL,
  "metric"     text NOT NULL,
  "value"      bigint NOT NULL,
  PRIMARY KEY ("tenant_id", "usage_date", "metric")
);

CREATE INDEX "tenant_usage_daily_tenant_idx" ON "tenant_usage_daily" ("tenant_id");
CREATE INDEX "tenant_usage_daily_tenant_date_idx" ON "tenant_usage_daily" ("tenant_id", "usage_date");

ALTER TABLE "tenant_usage_daily" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_usage_daily_tenant_isolation"
  ON "tenant_usage_daily"
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_usage_daily TO app_user';
  END IF;
END
$$;
