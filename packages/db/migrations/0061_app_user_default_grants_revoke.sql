-- analytics: excluded (no new table — grant fix only)
-- down:
--   GRANT INSERT, UPDATE, DELETE ON modules TO app_user;
--   GRANT INSERT, DELETE ON tenants TO app_user;
--   GRANT INSERT, DELETE ON platform_settings TO app_user;
--   GRANT UPDATE, DELETE ON admin_audit_log TO app_user;
--   -- (restores the over-grant this migration removes; do not apply this
--   -- rollback without also understanding why — see rationale below)

-- Issues #404, #405, and #406:
-- docker/postgres/init/001_setup.sql's default-privileges auto-grants SELECT, INSERT, UPDATE, DELETE
-- on every new table created by migration_user to app_user. Additive SELECT/UPDATE grants in migrations
-- do not automatically revoke the default-privilege DML grants. We must explicitly revoke them.

-- Issue #404: Revoke INSERT, UPDATE, DELETE on modules table from app_user (read-only catalog)
REVOKE INSERT, UPDATE, DELETE ON modules FROM app_user;

-- Issue #405: Revoke INSERT, DELETE on tenants table from app_user
REVOKE INSERT, DELETE ON tenants FROM app_user;

-- Issue #406: Revoke INSERT, DELETE on platform_settings table from app_user
REVOKE INSERT, DELETE ON platform_settings FROM app_user;

-- Finding 1 (PR 407 security review): Revoke UPDATE, DELETE on admin_audit_log from app_user (append-only)
REVOKE UPDATE, DELETE ON admin_audit_log FROM app_user;

