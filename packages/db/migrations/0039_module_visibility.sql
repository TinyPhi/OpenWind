-- Down migration:
-- ALTER TABLE modules DROP COLUMN IF EXISTS is_visible;

-- Global, platform-wide visibility toggle for templates (modules). Admin (the
-- platform's top role — no separate superadmin tier) turns this on/off per
-- template; when off, the template is hidden from the Templates page for
-- non-admin roles (agent/user). Not per-tenant — modules has no tenant_id
-- column, and this is deliberately a platform-operator concern, not a
-- tenant-level setting. Defaults to true so existing behavior (every seeded
-- module visible) is unchanged for this migration.
ALTER TABLE modules ADD COLUMN IF NOT EXISTS is_visible BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN modules.is_visible IS
  'Global platform-wide toggle (admin-controlled) — when false, this template is hidden from every tenant''s Templates page for non-admin roles.';

-- analytics: excluded (internal platform-config flag, not tenant/customer data)
