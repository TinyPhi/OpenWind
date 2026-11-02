-- Migration: 0159_modules_visibility_column_grant
-- analytics: excluded (no new table -- grant only)
-- down:
--   REVOKE UPDATE (is_visible, updated_at) ON modules FROM app_user;

-- Issue #1079 / ADR-005 Amendment 1: 0061 revoked every DML privilege on `modules` from app_user,
-- which also broke ModuleService.setVisibility (the admin visibility toggle updates
-- modules.is_visible as app_user). Restore exactly that one capability with a column-scoped grant,
-- mirroring 0062 on tenants. app_user still cannot INSERT, DELETE, or UPDATE any other column
-- (category, min_plan, version, ...): the catalog is written only by the migration role, via
-- syncModuleCatalog in packages/db/src/run-migrations.ts. The sync never touches is_visible, so an
-- operator's choice survives every re-sync.
--
-- 0061 already removed the table-level UPDATE, so no REVOKE is needed first (unlike 0062).
GRANT UPDATE (is_visible, updated_at) ON modules TO app_user;
