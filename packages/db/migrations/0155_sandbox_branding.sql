-- analytics: excluded (no new table -- a nullable column, a function and a CHECK constraint change only)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R12): a platform admin can set a
-- sandbox's display name and logo, which that sandbox's users see in the app header.
--
-- tenants.logo is a raster data URL (PNG, JPEG or WebP), never SVG: it is rendered through an
-- <img> only, and an SVG is the one image type that can carry script. The CHECK repeats what the
-- route enforces so a bug there still can't store anything else. 140000 characters is the base64
-- form of a 100 KB file (about 136,600) plus the prefix, with a little room.
--
-- platform_admin_role stays read-only on `tenants` (0135, ADR-022 Decision 1), as in 0142: it
-- gets EXECUTE on one narrow SECURITY DEFINER function instead of an UPDATE grant, so "sandboxes
-- only" is a property of the database and not of the calling code. status = 'active' keeps a
-- sandbox that is being deleted from reporting a successful change. search_path is pinned so the
-- definer's privileges can't be redirected through a caller-controlled schema. It also gets
-- SELECT on `logo` and nothing wider, so the dashboard can show the current logo.
--
-- tenant_lifecycle_role (0143) also gets UPDATE (logo), so the tenant purge can clear the logo
-- from the tombstone row it keeps: a deleted sandbox must not leave the prospect's image behind.
--
-- Builds on 0142_platform_admin_sandbox_trial, whose audit action CHECK this widens.
--
-- DOWN MIGRATION:
--   REVOKE UPDATE (logo) ON tenants FROM tenant_lifecycle_role;
--   REVOKE EXECUTE ON FUNCTION platform_admin_set_sandbox_branding(UUID, TEXT, TEXT, BOOLEAN)
--     FROM platform_admin_role;
--   DROP FUNCTION IF EXISTS platform_admin_set_sandbox_branding(UUID, TEXT, TEXT, BOOLEAN);
--   REVOKE SELECT (logo) ON tenants FROM platform_admin_role;
--   DELETE FROM platform_admin_audit_log WHERE action = 'sandbox.branding_changed';
--   ALTER TABLE platform_admin_audit_log DROP CONSTRAINT platform_admin_audit_log_action_check;
--   ALTER TABLE platform_admin_audit_log ADD CONSTRAINT platform_admin_audit_log_action_check
--     CHECK (action IN ('sandbox.created', 'sandbox.reset', 'sandbox.deleted',
--       'sandbox.trial_changed', 'sandbox.trial_ended'));
--   ALTER TABLE tenants DROP CONSTRAINT tenants_logo_check;
--   ALTER TABLE tenants DROP COLUMN logo;

ALTER TABLE tenants ADD COLUMN logo TEXT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_logo_check CHECK (
    logo IS NULL OR (
      logo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
      AND length(logo) <= 140000
    )
  );

-- p_name: NULL leaves the name alone, otherwise it is trimmed and must be 1-100 characters.
-- p_set_logo: false leaves the logo alone; true sets it to p_logo, and NULL there clears it.
-- Returns true when a row was changed, false when nothing was (no such active sandbox, a name
-- out of range, or nothing asked for).
CREATE OR REPLACE FUNCTION platform_admin_set_sandbox_branding(
  p_tenant_id UUID,
  p_name TEXT,
  p_logo TEXT,
  p_set_logo BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  changed INTEGER;
  new_name TEXT := btrim(p_name);
BEGIN
  IF p_name IS NULL AND NOT COALESCE(p_set_logo, false) THEN
    RETURN false;
  END IF;
  IF p_name IS NOT NULL AND (char_length(new_name) < 1 OR char_length(new_name) > 100) THEN
    RETURN false;
  END IF;
  UPDATE tenants
     SET name = COALESCE(new_name, name),
         logo = CASE WHEN COALESCE(p_set_logo, false) THEN p_logo ELSE logo END,
         updated_at = now()
   WHERE id = p_tenant_id
     AND is_sandbox
     AND status = 'active';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION platform_admin_set_sandbox_branding(UUID, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_set_sandbox_branding(UUID, TEXT, TEXT, BOOLEAN)
  TO platform_admin_role;
GRANT SELECT (logo) ON tenants TO platform_admin_role;
GRANT UPDATE (logo) ON tenants TO tenant_lifecycle_role;

ALTER TABLE platform_admin_audit_log
  DROP CONSTRAINT IF EXISTS platform_admin_audit_log_action_check;
ALTER TABLE platform_admin_audit_log
  ADD CONSTRAINT platform_admin_audit_log_action_check CHECK (
    action IN (
      'sandbox.created', 'sandbox.reset', 'sandbox.deleted',
      'sandbox.trial_changed', 'sandbox.trial_ended',
      'sandbox.branding_changed'
    )
  );
