-- Let per-user erasure and tenant purge delete from ticket_alerts and
-- access_requests as app_user (#635, docs/specs/gdpr-erasure-coverage.md F3).
--
-- DELETE /users/:userId deletes the target's ticket_alerts and access_requests
-- inside withTenantContext (SET LOCAL ROLE app_user), but 0045 and 0032 granted
-- only SELECT/INSERT/UPDATE. Every erasure therefore failed with
-- "permission denied" and rolled back before the Zitadel user was deleted.
--
-- Both tables are ordinary mutable tenant data; their RLS policies already
-- cover every command (ticket_alerts_tenant_isolation / access_requests_tenant_isolation,
-- FOR ALL), so this adds no cross-tenant reach. Append-only tables
-- (admin_audit_log, schedule_executions) are deliberately NOT changed.
--
-- entity_instance_tags (0108) is add/remove only, so it never needed UPDATE.
-- Per-user erasure must redact created_by on tags the user added to other
-- people's tickets; the grant is column-level so tag_text stays immutable.
--
-- Rollback:
--   REVOKE DELETE ON ticket_alerts FROM app_user;
--   REVOKE DELETE ON access_requests FROM app_user;
--   REVOKE UPDATE (created_by) ON entity_instance_tags FROM app_user;

GRANT DELETE ON ticket_alerts TO app_user;
GRANT DELETE ON access_requests TO app_user;
GRANT UPDATE (created_by) ON entity_instance_tags TO app_user;
