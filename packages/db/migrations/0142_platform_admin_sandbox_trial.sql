-- analytics: excluded (no new table -- a function and a CHECK constraint change only)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R6a): a platform admin can change
-- a sandbox's trial end date, including pushing an expired one into the future (reactivation).
--
-- platform_admin_role stays read-only on `tenants` (migration 0135, ADR-022 Decision 1): it
-- gets EXECUTE on one SECURITY DEFINER function instead of an UPDATE grant. A column grant
-- can't be restricted to sandbox rows, so a route bug could then rewrite a regular tenant's
-- trial and lock its users out; the function's WHERE clause makes "sandboxes only" a property
-- of the database, not of the calling code. status = 'active' keeps a sandbox that is being
-- deleted (status already flipped by the delete worker) from reporting a successful change.
-- search_path is pinned so the definer's privileges can't be redirected through a
-- caller-controlled schema.
--
-- Numbered 0142: 0141 is taken by fix/tenant-lifecycle-role (#869). Renumber at merge if the
-- land order needs it.
--
-- DOWN MIGRATION:
--   REVOKE EXECUTE ON FUNCTION platform_admin_set_sandbox_trial(UUID, TIMESTAMPTZ)
--     FROM platform_admin_role;
--   DROP FUNCTION IF EXISTS platform_admin_set_sandbox_trial(UUID, TIMESTAMPTZ);
--   ALTER TABLE platform_admin_audit_log DROP CONSTRAINT platform_admin_audit_log_action_check;
--   ALTER TABLE platform_admin_audit_log ADD CONSTRAINT platform_admin_audit_log_action_check
--     CHECK (action IN ('sandbox.created', 'sandbox.reset', 'sandbox.deleted'));

CREATE OR REPLACE FUNCTION platform_admin_set_sandbox_trial(
  p_tenant_id UUID,
  p_trial_ends_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE tenants
     SET trial_ends_at = p_trial_ends_at,
         updated_at = now()
   WHERE id = p_tenant_id
     AND is_sandbox
     AND status = 'active';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION platform_admin_set_sandbox_trial(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_set_sandbox_trial(UUID, TIMESTAMPTZ)
  TO platform_admin_role;

ALTER TABLE platform_admin_audit_log
  DROP CONSTRAINT IF EXISTS platform_admin_audit_log_action_check;
ALTER TABLE platform_admin_audit_log
  ADD CONSTRAINT platform_admin_audit_log_action_check CHECK (
    action IN ('sandbox.created', 'sandbox.reset', 'sandbox.deleted', 'sandbox.trial_changed')
  );
