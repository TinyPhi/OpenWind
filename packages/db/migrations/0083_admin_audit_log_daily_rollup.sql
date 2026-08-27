-- ============================================================
-- Migration: 0083_admin_audit_log_daily_rollup
-- ADR-012 Phase G, spec R8 -- aggregate counts (requests per resource
-- type/action, allowed-vs-denied ratios derivable from action) that
-- survive the 90-day admin_audit_log detail-row sweep (apps/worker/src/
-- access-log-retention.ts). One row per (tenant, day, resource_type,
-- action); "outcome" is deliberately NOT a stored column -- it's derived
-- from `action` at query time via @platform/audit's classifyOutcome, the
-- one place action-outcome semantics live (ADR-012 Phase F, spec §V).
-- ============================================================
--
-- DOWN MIGRATION (rollback):
-- DROP POLICY IF EXISTS "admin_audit_log_daily_rollup_tenant_isolation" ON "admin_audit_log_daily_rollup";
-- ALTER TABLE "admin_audit_log_daily_rollup" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "admin_audit_log_daily_rollup_tenant_day_idx";
-- DROP TABLE IF EXISTS "admin_audit_log_daily_rollup";
--
-- analytics: excluded (this table IS the analytics/aggregate surface for
--            admin_audit_log -- no separate analytics pipeline needed)

CREATE TABLE "admin_audit_log_daily_rollup" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      uuid        NOT NULL,
  "day"            date        NOT NULL,
  "resource_type"  text        NOT NULL,
  "action"         text        NOT NULL,
  "count"          bigint      NOT NULL DEFAULT 0 CHECK ("count" >= 0),
  CONSTRAINT "admin_audit_log_daily_rollup_scope_unique"
    UNIQUE ("tenant_id", "day", "resource_type", "action")
);

-- Lookup: a tenant's rollup rows for a date range (admin-ui aggregate view).
CREATE INDEX "admin_audit_log_daily_rollup_tenant_day_idx"
  ON "admin_audit_log_daily_rollup" ("tenant_id", "day");

-- Final /security-review (spec R13) finding: admin_audit_log itself DOES
-- have RLS (migration 0011) -- the original comment here claiming a
-- "no-RLS precedent" was factually wrong. RLS is the second, defense-in-
-- depth layer (security.md invariant #1) and must exist on every
-- tenant-scoped table regardless of who writes it today; a future
-- admin-ui read route for this rollup data must not be able to leak
-- another tenant's counts if it ever forgets its own explicit filter.
ALTER TABLE "admin_audit_log_daily_rollup" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_audit_log_daily_rollup_tenant_isolation"
  ON "admin_audit_log_daily_rollup"
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT ON admin_audit_log_daily_rollup TO app_user';
  END IF;
END
$$;
