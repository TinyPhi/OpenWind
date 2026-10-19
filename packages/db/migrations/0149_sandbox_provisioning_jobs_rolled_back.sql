-- analytics: excluded (platform-level job tracking column)
--
-- docs/specs/multi-org-sandbox.md T11, ADR-022. Surfaces whether automatic rollback
-- (Zitadel org deletion + tenant row deletion) completed successfully on provisioning failure.
-- Deliberately nullable: existing rows and pending/running jobs have rolled_back = NULL;
-- failed jobs have rolled_back = true if full cleanup succeeded, or false if Zitadel org
-- deletion failed (leaving the tenant row as an operator breadcrumb).
--
-- DOWN MIGRATION:
--   ALTER TABLE "sandbox_provisioning_jobs" DROP COLUMN IF EXISTS "rolled_back";

ALTER TABLE "sandbox_provisioning_jobs" ADD COLUMN "rolled_back" boolean;
