-- Revoke the table-level UPDATE first, then re-grant column-scoped only
-- down: GRANT UPDATE ON tenants TO app_user;
REVOKE UPDATE ON tenants FROM app_user;
GRANT UPDATE (config, updated_at) ON tenants TO app_user;
