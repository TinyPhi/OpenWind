-- Down migration:
-- ALTER TABLE modules DROP COLUMN IF EXISTS category;

-- ADR-005 (accepted, PR #164): classifies modules as 'core' (auto-installed
-- during tenant provisioning — see apps/api/src/lib/tenant-lifecycle.ts's
-- provisionTenant) or 'optional' (installed manually via the Templates
-- page). Defaults to 'optional' so any module row not explicitly classified
-- in ModuleService.seedRegistry() never auto-installs.
ALTER TABLE modules ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'optional'
  CHECK (category IN ('core', 'optional'));

COMMENT ON COLUMN modules.category IS
  'ADR-005: ''core'' modules auto-install on tenant provisioning; ''optional'' modules require a manual install.';

-- analytics: excluded (internal platform-config flag, not tenant/customer data)
