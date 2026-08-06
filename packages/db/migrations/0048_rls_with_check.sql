-- #263: Add WITH CHECK to 4 tables that only had USING-only RLS policies.
--
-- Without WITH CHECK, a row can be INSERTed or UPDATEd with a tenant_id that
-- doesn't match the current session's app.tenant_id GUC — the row becomes
-- invisible to the inserting session (filtered by USING) but it exists in the
-- DB and is readable by that other tenant. The explicit WHERE tenant_id = ?
-- in application queries is the primary guard; this closes the DB-level gap.
--
-- ALTER POLICY supports adding WITH CHECK in-place without dropping the policy.

ALTER POLICY access_requests_tenant_isolation ON access_requests
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER POLICY notifications_tenant_isolation ON notifications
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER POLICY notification_recipients_tenant_isolation ON notification_recipients
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER POLICY ticket_alerts_tenant_isolation ON ticket_alerts
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
