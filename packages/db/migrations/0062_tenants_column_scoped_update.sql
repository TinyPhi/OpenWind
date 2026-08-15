-- analytics: excluded (no new table — grant fix only)
-- down:
--   REVOKE UPDATE ON tenants FROM app_user;
--   GRANT UPDATE ON tenants TO app_user;

-- Issue #408: Enforce column-scoped UPDATE on tenants for app_user.
-- Alter default privileges and previous migrations granted table-level UPDATE.
-- We must revoke the table-level UPDATE privilege first, then grant column-scoped UPDATE only.
REVOKE UPDATE ON tenants FROM app_user;
GRANT UPDATE (config, updated_at) ON tenants TO app_user;
