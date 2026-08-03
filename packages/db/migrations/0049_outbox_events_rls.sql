-- analytics: excluded
-- down:
--   DROP POLICY IF EXISTS "outbox_events_tenant_isolation" ON "outbox_events";
--   ALTER TABLE "outbox_events" DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS "dead_letter_events_tenant_isolation" ON "dead_letter_events";
--   ALTER TABLE "dead_letter_events" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "outbox_events_tenant_isolation"
  ON "outbox_events"
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "dead_letter_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dead_letter_events_tenant_isolation"
  ON "dead_letter_events"
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
