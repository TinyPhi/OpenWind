-- analytics: excluded (operational security audit trail, not business/usage data)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md), Phase 3 / T16.
-- ADR-022 (docs/decisions/ADR-022-sandboxing.md) Decision 7: platform-admin lifecycle actions
-- (create/reset/delete a sandbox) don't resolve to a single tenant the way every other
-- admin_audit_log entry does -- most clearly for a failed-or-abandoned create, which has no
-- tenant yet. Rather than widen admin_audit_log's NOT NULL tenant_id, this is a dedicated,
-- platform-level table: no RLS (it is not tenant data), no tenant_id column (so neither
-- erasure-table-coverage-guard nor erasure-user-column-coverage-guard scan it -- both only
-- select from information_schema where a tenant_id column exists, same reasoning already
-- applied to sandbox_provisioning_jobs in migration 0137). Per spec R9, only completed
-- actions are recorded -- a failed/in-progress attempt is visible live via the
-- provisioning-progress UI (R5) instead, never duplicated here.
--
-- DOWN MIGRATION:
--   REVOKE SELECT ON platform_admin_audit_log FROM platform_admin_role;
--   DROP TABLE IF EXISTS platform_admin_audit_log;

CREATE TABLE IF NOT EXISTS platform_admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Zitadel user id of the platform_admin who performed the action.
  actor_sub TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('sandbox.created', 'sandbox.reset', 'sandbox.deleted')
  ),
  -- The tenant the action targeted. No FK: `sandbox.deleted` rows must survive the target
  -- tenant row being gone entirely, same reasoning as other append-only audit tables in this
  -- codebase not FK-ing to rows they outlive.
  target_tenant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_admin_audit_log_created_at_idx
  ON platform_admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_admin_audit_log_target_tenant_id_idx
  ON platform_admin_audit_log (target_tenant_id);

-- Read-only grant: this table is written by trusted worker code on the privileged `db`
-- connection (see apps/worker/src/sandbox-{provisioning,reset,delete}-worker.ts), never by a
-- platform_admin-role session -- same division as tenants' lifecycle columns (migration
-- 0135), where platform_admin_role only ever reads what the worker/API layer writes.
GRANT SELECT ON platform_admin_audit_log TO platform_admin_role;
