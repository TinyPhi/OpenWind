-- analytics: excluded (attempt/error metadata for connector outbound delivery —
-- same reasoning as dead_letter_events/outbox_events: operational data, not
-- analytics surface, and `error` can carry response-body fragments from a
-- third-party target)
--
-- ADR-009 Decision #9 (issue #365): a delivery-attempt record for connector
-- outbound delivery. One row per attempt (not per logical delivery) — without
-- this, a dead-lettered delivery simply disappears (dead_letter_events has
-- zero readers anywhere in apps/api or apps/admin-ui today), making
-- retrospective reconstruction of "what did we try, when, and why did it
-- fail" impossible even though a redrive UI is deliberately out of scope for
-- this migration.
--
-- Modeled structurally on 0005_dead_letter_events.sql (same tenant-scoped
-- shape, same tenant+created_at index for operator inspection queries), but
-- with current best-practice RLS (USING + WITH CHECK — see 0048/0049; a new
-- table should not ship with the gap those migrations closed).
--
-- connector_id is nullable + ON DELETE SET NULL, matching
-- dead_letter_events.original_event_id's pattern: the attempt record must
-- outlive the connector_definitions row it references (e.g. connector
-- uninstalled from the catalog after delivery attempts were already logged).
--
-- delivery_id is the idempotency identifier sent in the outbound request's
-- X-OpenWind-Delivery-Id header (mirrors svix-id) — stable across every retry
-- attempt of the same logical delivery, so the receiving endpoint can dedupe.
-- It is NOT unique here: every attempt of the same logical delivery shares
-- one delivery_id across multiple rows (one per attempt_number).
--
-- next_retry_at is set on a 'failed' row that still has attempts remaining
-- (BullMQ will retry); NULL on 'success' and 'exhausted' rows.
--
-- Down migration (rollback):
-- DROP POLICY IF EXISTS "connector_delivery_attempts_tenant_isolation" ON "connector_delivery_attempts";
-- ALTER TABLE "connector_delivery_attempts" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "connector_delivery_attempts_tenant_created_idx";
-- DROP INDEX IF EXISTS "connector_delivery_attempts_delivery_id_idx";
-- DROP TABLE IF EXISTS "connector_delivery_attempts";
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON connector_delivery_attempts FROM app_user;

CREATE TABLE "connector_delivery_attempts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL REFERENCES "tenants"("id"),
  "connector_id"    uuid REFERENCES "connector_definitions"("id") ON DELETE SET NULL,
  "delivery_id"     uuid NOT NULL,
  "status"          text NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'exhausted')),
  "attempt_number"  integer NOT NULL,
  "latency_ms"      integer,
  "error"           text,
  "next_retry_at"   timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

-- Tenant + time index for operator inspection queries — matches
-- dead_letter_events_tenant_created_idx exactly.
CREATE INDEX "connector_delivery_attempts_tenant_created_idx"
  ON "connector_delivery_attempts" ("tenant_id", "created_at");

-- Lookup path for updating a specific attempt row (pending -> success/failed/
-- exhausted) and for reconstructing a logical delivery's full attempt history.
CREATE INDEX "connector_delivery_attempts_delivery_id_idx"
  ON "connector_delivery_attempts" ("delivery_id");

ALTER TABLE "connector_delivery_attempts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connector_delivery_attempts_tenant_isolation"
  ON "connector_delivery_attempts"
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- app_user: workers INSERT the initial 'pending' row and UPDATE it to a
-- terminal status. DELETE is granted too (unlike dead_letter_events' original
-- 0019 grant, which needed a follow-up migration 0022 to add it) because
-- apps/worker/src/tenant-purge.ts's tenant-scoped delete runs inside
-- withTenantContext (SET LOCAL ROLE app_user) same as every other table it
-- purges — granting it here from the start avoids repeating that two-step.
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_delivery_attempts TO app_user;
