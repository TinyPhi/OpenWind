-- Down migration:
-- DROP INDEX IF EXISTS "automation_executions_rule_transition_completed_idx";
-- ALTER TABLE "automation_executions" DROP COLUMN "transition_event_id";

ALTER TABLE "automation_executions"
  ADD COLUMN "transition_event_id" uuid;

-- Partial (status='completed' only) so a failed/incomplete execution never
-- permanently blocks a later retry for the same (rule_id, transition_event_id)
-- pair — see docs/specs/outbox-automation-idempotent-consumption.md §V.
CREATE UNIQUE INDEX "automation_executions_rule_transition_completed_idx"
  ON "automation_executions" ("rule_id", "transition_event_id")
  WHERE "transition_event_id" IS NOT NULL AND "status" = 'completed';
