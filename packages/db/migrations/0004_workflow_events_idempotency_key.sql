-- Down migration:
-- DROP INDEX IF EXISTS "workflow_events_instance_idempotency_idx";
-- ALTER TABLE "workflow_events" DROP COLUMN "idempotency_key";

ALTER TABLE "workflow_events"
  ADD COLUMN "idempotency_key" text;

CREATE UNIQUE INDEX "workflow_events_instance_idempotency_idx"
  ON "workflow_events" ("instance_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
