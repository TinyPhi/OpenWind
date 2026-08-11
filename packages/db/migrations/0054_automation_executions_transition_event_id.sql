-- Down migration:
-- DROP INDEX IF EXISTS "automation_executions_rule_transition_success_idx";
-- ALTER TABLE "automation_executions" DROP COLUMN "transition_event_id";

-- analytics: excluded (internal dedup key, not a business metric)
ALTER TABLE "automation_executions"
  ADD COLUMN "transition_event_id" uuid;

-- Partial (status='success' only) so a failed/incomplete execution never
-- permanently blocks a later retry for the same (rule_id, transition_event_id)
-- pair — see docs/specs/outbox-automation-idempotent-consumption.md §V.
-- executor.ts's terminal statuses are 'success'/'degraded'/'failed', never
-- 'completed' (PR #372 review, H1) — 'completed' here would never match any
-- row, permanently disabling this index and Phase 2's planned dedup SELECT.
CREATE UNIQUE INDEX "automation_executions_rule_transition_success_idx"
  ON "automation_executions" ("rule_id", "transition_event_id")
  WHERE "transition_event_id" IS NOT NULL AND "status" = 'success';
