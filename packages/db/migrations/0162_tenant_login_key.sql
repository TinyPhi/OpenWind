-- analytics: excluded (no new table -- a nullable column on `tenants`, constraints and grants only)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R13, revised 2026-10-27): a sandbox's
-- login link is /login?org=<login_key>. The first version used the tenant slug, which is the org's
-- name plus four digits, so anyone who guessed a company name could try its ten thousand suffixes
-- and learn that it has a sandbox. The login key is random and has no relation to the name.
--
-- login_key is 16 lowercase hex characters, unique, set when a sandbox is created and never changed.
-- Real tenants have none: a CHECK keeps the column NULL unless is_sandbox, so a customer tenant can
-- never be reached through the public login lookup whatever a route forgets to filter. Existing
-- sandboxes get a key here, from gen_random_uuid() (a strong random source; its first 16 hex
-- characters carry 60 random bits, the 13th being the fixed version digit). Keys the worker makes
-- come from 8 random bytes, 64 bits.
--
-- platform_admin_role (0135, 0144, 0155) reads the key so the dashboard can show the link, and no
-- longer reads the slug, which 0161 had granted for the first version and nothing needs now. It gets
-- no UPDATE on `tenants` (still only through the audited SECURITY DEFINER functions).
--
-- DOWN MIGRATION:
--   GRANT SELECT (slug) ON tenants TO platform_admin_role;
--   REVOKE SELECT (login_key) ON tenants FROM platform_admin_role;
--   ALTER TABLE tenants DROP CONSTRAINT tenants_login_key_key;
--   ALTER TABLE tenants DROP CONSTRAINT tenants_login_key_sandbox_only;
--   ALTER TABLE tenants DROP CONSTRAINT tenants_login_key_check;
--   ALTER TABLE tenants DROP COLUMN login_key;

ALTER TABLE tenants ADD COLUMN login_key TEXT;

-- Per-row: gen_random_uuid() is volatile, so each sandbox gets its own value.
UPDATE tenants
   SET login_key = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)
 WHERE is_sandbox AND login_key IS NULL;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_login_key_check
  CHECK (login_key IS NULL OR login_key ~ '^[0-9a-f]{16}$');

ALTER TABLE tenants
  ADD CONSTRAINT tenants_login_key_sandbox_only
  CHECK (login_key IS NULL OR is_sandbox);

-- A unique constraint allows any number of NULLs, so real tenants do not collide.
ALTER TABLE tenants ADD CONSTRAINT tenants_login_key_key UNIQUE (login_key);

GRANT SELECT (login_key) ON tenants TO platform_admin_role;
REVOKE SELECT (slug) ON tenants FROM platform_admin_role;
