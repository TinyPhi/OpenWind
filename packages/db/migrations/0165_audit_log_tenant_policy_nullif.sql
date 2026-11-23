-- Migration: 0165_audit_log_tenant_policy_nullif
-- analytics: excluded (RLS policy fix only -- no new table)
--
-- #1188. The tenant isolation policies on admin_audit_log (0011) and
-- admin_audit_log_daily_rollup (0083) cast current_setting('app.tenant_id', true)
-- straight to uuid. After any transaction-local set_config, a pooled connection
-- reads the setting back as '' (not NULL) for the rest of its life, and ''::uuid
-- throws `invalid input syntax for type uuid: ""`. Permissive policies are OR'd,
-- so this policy is evaluated for every row a role-switched sweep's own policy
-- rejects, and the sweep dies on a connection that earlier ran a tenant
-- transaction. access_log_retention_role (0158) is the shipped case, reproduced
-- in apps/worker/tests/isolation/audit-policy-nullif.isolation.test.ts. Same
-- defect and same fix as api_keys in 0090.
--
-- NULLIF(..., '') collapses the reset value back to NULL, so an unset or reset
-- tenant matches no rows instead of raising: the fail-closed behaviour ADR-001
-- intends. Tenant sessions that set a real tenant are unaffected.
--
-- Scope: these two tables only. ~39 other policies still use the bare cast; they are
-- tracked in #1188 and have no known bare-query path.
--
-- DOWN MIGRATION (restores the bare cast):
--   ALTER POLICY "audit_log_tenant_isolation" ON "admin_audit_log"
--     USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
--   ALTER POLICY "admin_audit_log_daily_rollup_tenant_isolation" ON "admin_audit_log_daily_rollup"
--     USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
--     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER POLICY "audit_log_tenant_isolation" ON "admin_audit_log"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER POLICY "admin_audit_log_daily_rollup_tenant_isolation" ON "admin_audit_log_daily_rollup"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
