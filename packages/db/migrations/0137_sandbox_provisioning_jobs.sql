-- Down migration (rollback):
-- REVOKE SELECT ON sandbox_provisioning_jobs FROM platform_admin_role;
-- DROP TABLE IF EXISTS "sandbox_provisioning_jobs";

-- analytics: excluded (platform-level job tracking row, not tenant-scoped data — see
-- result_tenant_id note below)
--
-- docs/specs/multi-org-sandbox.md T8/T21 (Phase 2), ADR-022. Tracks one sandbox
-- provisioning job's progress end to end: R5's "trackable job with step-by-step progress
-- persisted as it happens" and "a failure partway through records where it got to".
--
-- Deliberately named result_tenant_id, NOT tenant_id: the row exists before any tenant
-- is created (job starts as 'pending' with no tenant yet) and this table is never
-- per-tenant data to begin with (it is platform_admin's own job bookkeeping, same
-- platform-level status as `modules`/`connector_definitions` -- see those migrations for
-- the same no-tenant-id/no-RLS pattern). Naming it `tenant_id` would make
-- apps/worker/tests/isolation/erasure-table-coverage-guard.isolation.test.ts treat this
-- as a tenant-owned table requiring a PURGED_TENANT_TABLES/ERASURE_EXEMPT_TABLES entry it
-- doesn't actually need -- it holds no tenant's business data, only a reference to the
-- tenant a (possibly already-complete) provisioning run created.
--
-- No RLS: platform-level, like `modules`/`connector_definitions`. Readable only via
-- platform_admin_role's column-scoped GRANT below, mirroring 0134's pattern for `tenants`
-- metadata -- this table has no business data, so the grant below covers every column,
-- not a narrower allow-list the way 0134's `tenants` grant is narrower than the full row.
--
-- id is the BullMQ job id (set explicitly by the API route at enqueue time via
-- `{ jobId: id }`), not DB-generated -- the API route needs the id before enqueuing so it
-- can insert the initial 'pending' row and return the same id to the caller.
--
-- Deliberately holds NO credentials: an earlier version of this migration also had
-- `seeded_accounts`/`default_password` columns, but security review flagged that as a
-- materially larger, unbounded blast radius than the ~1h BullMQ-job-result window it
-- replaced -- every current and future platform_admin could read every sandbox's working
-- Zitadel password forever, with no expiry and no FK-cascade cleanup tied to tenant
-- deletion. T21's handover artifact instead lives in Redis with a 7-day TTL
-- (packages/auth/src/sandbox-handover-store.ts), bounding exposure to recently-provisioned
-- sandboxes the way the original design intended.

CREATE TABLE "sandbox_provisioning_jobs" (
  "id"                uuid        PRIMARY KEY,
  "result_tenant_id"  uuid        REFERENCES tenants(id),
  "requested_by"      text        NOT NULL,
  "org_name"          text        NOT NULL,
  "status"            text        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  "current_step"      text,
  "completed_steps"   integer     NOT NULL DEFAULT 0,
  "total_steps"       integer     NOT NULL DEFAULT 0,
  "zitadel_org_id"    text,
  "error"             text,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "sandbox_provisioning_jobs_requested_by_idx"
  ON "sandbox_provisioning_jobs" ("requested_by");

GRANT SELECT ON "sandbox_provisioning_jobs" TO platform_admin_role;
