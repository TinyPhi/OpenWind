-- analytics: excluded (no new table -- functions and a CHECK constraint change only)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R6a): a platform admin can extend a
-- sandbox's trial (reactivating an expired one) or end a running trial immediately.
--
-- platform_admin_role stays read-only on `tenants` (migration 0135, ADR-022 Decision 1): it
-- gets EXECUTE on two narrow SECURITY DEFINER functions instead of an UPDATE grant. A column
-- grant can't be restricted to sandbox rows, so a route bug could then rewrite a regular
-- tenant's trial and lock its users out; the functions' WHERE clauses make "sandboxes only" a
-- property of the database, not of the calling code. status = 'active' keeps a sandbox that is
-- being deleted (status already flipped by the delete worker) from reporting a successful
-- change. search_path is pinned so the definer's privileges can't be redirected through a
-- caller-controlled schema.
--
-- Each function is a single UPDATE that computes the new end from the row's current value
-- (PR #880 review B): two concurrent extends both take the row lock in turn and stack, rather
-- than both reading the same end and the second overwriting the first.
--
-- Builds on 0141_platform_admin_audit_log (#859), whose action CHECK this widens. Merges before
-- #869, whose tenant_lifecycle_role migration renumbers to 0143 when it lands second.
--
-- DOWN MIGRATION:
--   REVOKE EXECUTE ON FUNCTION platform_admin_extend_sandbox_trial(UUID, INTEGER)
--     FROM platform_admin_role;
--   REVOKE EXECUTE ON FUNCTION platform_admin_end_sandbox_trial(UUID) FROM platform_admin_role;
--   DROP FUNCTION IF EXISTS platform_admin_extend_sandbox_trial(UUID, INTEGER);
--   DROP FUNCTION IF EXISTS platform_admin_end_sandbox_trial(UUID);
--   ALTER TABLE platform_admin_audit_log DROP CONSTRAINT platform_admin_audit_log_action_check;
--   ALTER TABLE platform_admin_audit_log ADD CONSTRAINT platform_admin_audit_log_action_check
--     CHECK (action IN ('sandbox.created', 'sandbox.reset', 'sandbox.deleted'));

-- Extend by p_days from the later of the current end and now: a running trial gets p_days more,
-- an expired or unset one runs p_days from now (which reactivates it). Returns the new end, or
-- NULL when no active sandbox has that id (or p_days is out of range) and nothing changed.
CREATE OR REPLACE FUNCTION platform_admin_extend_sandbox_trial(
  p_tenant_id UUID,
  p_days INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_end TIMESTAMPTZ;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RETURN NULL;
  END IF;
  UPDATE tenants
     SET trial_ends_at = GREATEST(now(), COALESCE(trial_ends_at, now()))
                         + make_interval(days => p_days),
         updated_at = now()
   WHERE id = p_tenant_id
     AND is_sandbox
     AND status = 'active'
  RETURNING trial_ends_at INTO new_end;
  RETURN new_end;
END;
$$;

-- End a running trial now. Only touches a trial that is currently active, so it can never
-- turn a sandbox with no trial into an expired one (PR #880 review C). Returns the new end, or
-- NULL when nothing changed.
CREATE OR REPLACE FUNCTION platform_admin_end_sandbox_trial(
  p_tenant_id UUID
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_end TIMESTAMPTZ;
BEGIN
  UPDATE tenants
     SET trial_ends_at = now(),
         updated_at = now()
   WHERE id = p_tenant_id
     AND is_sandbox
     AND status = 'active'
     AND trial_ends_at > now()
  RETURNING trial_ends_at INTO new_end;
  RETURN new_end;
END;
$$;

REVOKE ALL ON FUNCTION platform_admin_extend_sandbox_trial(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_admin_end_sandbox_trial(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_extend_sandbox_trial(UUID, INTEGER)
  TO platform_admin_role;
GRANT EXECUTE ON FUNCTION platform_admin_end_sandbox_trial(UUID) TO platform_admin_role;

ALTER TABLE platform_admin_audit_log
  DROP CONSTRAINT IF EXISTS platform_admin_audit_log_action_check;
ALTER TABLE platform_admin_audit_log
  ADD CONSTRAINT platform_admin_audit_log_action_check CHECK (
    action IN (
      'sandbox.created', 'sandbox.reset', 'sandbox.deleted',
      'sandbox.trial_changed', 'sandbox.trial_ended'
    )
  );
