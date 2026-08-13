-- analytics: excluded (plugin catalog metadata + tenant install/error state — no
-- analytics surface; plugin_errors.detail can carry stack traces / query fragments)
--
-- 3B plugin system, Phase 1 (docs/specs/plugin-system.md R1/R2/R4/R4-addendum/R8).
--
-- Down migration (rollback):
--   REVOKE EXECUTE ON FUNCTION create_plugin_schema(text) FROM app_user;
--   DROP FUNCTION IF EXISTS create_plugin_schema(text);
--   DROP POLICY IF EXISTS "plugin_errors_tenant_isolation" ON "plugin_errors";
--   ALTER TABLE "plugin_errors" DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS "plugin_errors";
--   DROP POLICY IF EXISTS "installed_plugins_tenant_isolation" ON "installed_plugins";
--   ALTER TABLE "installed_plugins" DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS "installed_plugins";
--   REVOKE SELECT ON plugin_definitions FROM app_user;
--   DROP TABLE IF EXISTS "plugin_definitions";

-- plugin_definitions — platform-wide plugin catalog (no tenant_id/RLS, same class as
-- connector_definitions/modules — ADR-001's "Non-tenant-scoped tables"). Declarative
-- metadata only; the manifest itself (PluginManifest — permissions, slot/page
-- registrations, remoteEntry URL) is NOT duplicated into columns, same reasoning
-- connector_definitions uses for triggers/actions.
--
-- trust_tier is a single-value enum today by design (R1): admitting a second tier
-- later is a CHECK-constraint change, not a migration redesign — mirrors
-- api_keys.scopes_format's explicit-column precedent (ADR-008 Decision #6).
CREATE TABLE "plugin_definitions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"        text NOT NULL UNIQUE,
  "name"        text NOT NULL,
  "version"     text NOT NULL,
  "description" text,
  "icon_url"    text,
  "docs_url"    text,
  "category"    text NOT NULL,
  "trust_tier"  text NOT NULL DEFAULT 'first_party' CHECK (trust_tier IN ('first_party')),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  -- Plugin slugs become Postgres identifiers (schema/role names — see
  -- create_plugin_schema below), so the format is constrained here, not just
  -- validated in application code: lowercase, starts with a letter, alnum+underscore
  -- only, capped at 40 chars (leaves room for the "plugin_"/"plugin_role_" prefixes
  -- under Postgres's 63-byte identifier limit).
  CONSTRAINT "plugin_definitions_slug_format" CHECK (slug ~ '^[a-z][a-z0-9_]{2,40}$')
);

GRANT SELECT ON plugin_definitions TO app_user;
-- docker/postgres/init/001_setup.sql's ALTER DEFAULT PRIVILEGES auto-grants
-- INSERT/UPDATE/DELETE to app_user on every new table migration_user creates —
-- an explicit GRANT SELECT alone does NOT narrow that back down (a later
-- explicit grant never revokes an earlier default-privileges grant). Without
-- this REVOKE, app_user could write directly to this catalog table, defeating
-- R1's "writable only by migration_user/admin-role endpoints" intent.
REVOKE INSERT, UPDATE, DELETE ON plugin_definitions FROM app_user;

-- installed_plugins — tenant-scoped install row (R2). manifest_snapshot freezes the
-- exact PluginManifest this tenant installed, so a later plugin_definitions update
-- doesn't retroactively change what's already running for them.
CREATE TABLE "installed_plugins" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL REFERENCES "tenants"("id"),
  "plugin_id"         uuid NOT NULL REFERENCES "plugin_definitions"("id"),
  "manifest_snapshot" jsonb NOT NULL,
  "version"           text NOT NULL,
  "status"            text NOT NULL DEFAULT 'installing'
                         CHECK (status IN ('installing', 'active', 'error', 'disabled')),
  "error_reason"      text,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "installed_plugins_tenant_plugin_unique" UNIQUE ("tenant_id", "plugin_id")
);

CREATE INDEX "installed_plugins_tenant_idx" ON "installed_plugins" ("tenant_id");

ALTER TABLE "installed_plugins" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "installed_plugins_tenant_isolation"
  ON "installed_plugins"
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON installed_plugins TO app_user;

-- plugin_errors — R8. Any lifecycle failure / governor-limit breach / runtime
-- exception writes here instead of crashing the platform process. plugin_id is
-- nullable + ON DELETE SET NULL, matching connector_delivery_attempts' pattern:
-- the error record must outlive the catalog row it references.
CREATE TABLE "plugin_errors" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  uuid NOT NULL REFERENCES "tenants"("id"),
  "plugin_id"  uuid REFERENCES "plugin_definitions"("id") ON DELETE SET NULL,
  "kind"       text NOT NULL
                 CHECK (kind IN ('lifecycle_failure', 'governor_limit_breach', 'runtime_exception')),
  "detail"     jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "plugin_errors_tenant_created_idx" ON "plugin_errors" ("tenant_id", "created_at");

ALTER TABLE "plugin_errors" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plugin_errors_tenant_isolation"
  ON "plugin_errors"
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, DELETE ON plugin_errors TO app_user;
-- Same default-privileges correction as plugin_definitions above — plugin_errors
-- is append-only during normal operation (matches admin_audit_log's posture),
-- so UPDATE is revoked; DELETE stays granted (unlike admin_audit_log) because
-- apps/worker/src/tenant-purge.ts deletes a purged tenant's error rows via
-- withTenantContext (SET LOCAL ROLE app_user) — same gap migration 0022 already
-- fixed once for dead_letter_events, for the identical reason.
REVOKE UPDATE ON plugin_errors FROM app_user;

-- create_plugin_schema — R4's enforcement mechanism ("by grant, not convention") and
-- R4-addendum. A plugin's migration must run under a role that can create objects in
-- plugin_<slug> and NOTHING else — not public, not another plugin's schema. Rather
-- than granting the API server's own runtime connection CREATEROLE/CREATEDB (a much
-- larger privilege than this narrow need justifies), this is the same "narrowly-scoped
-- SECURITY DEFINER escape hatch" pattern resolve_api_key_by_hash (migration 0031)
-- already established for a different RLS-adjacent problem: a function owned by the
-- migration-running role (which does have CREATEROLE/CREATEDB), callable only by
-- app_user, that does exactly one thing and nothing else.
--
-- Slug format is re-validated here (belt-and-suspenders with the CHECK constraint
-- above — a plugin_definitions row is the only source of a slug reaching this
-- function, but the function must be safe to call with an arbitrary string on its
-- own terms, independent of that table's constraint ever being bypassed) before it is
-- ever interpolated into a dynamic identifier, and every dynamic identifier uses
-- format(%I, ...) — Postgres's own safe identifier quoting — never string
-- concatenation. The created role is NOLOGIN (never a login role — app_user reaches
-- it only via GRANT ... TO app_user + SET LOCAL ROLE inside a transaction, the exact
-- mechanism 0019_create_app_user.sql already uses for app_user itself) and has
-- privileges on its own schema only.
CREATE FUNCTION create_plugin_schema(plugin_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_schema_name text;
  v_role_name   text;
BEGIN
  IF plugin_slug !~ '^[a-z][a-z0-9_]{2,40}$' THEN
    RAISE EXCEPTION 'create_plugin_schema: invalid plugin slug %', plugin_slug;
  END IF;

  v_schema_name := 'plugin_' || plugin_slug;
  v_role_name   := 'plugin_role_' || plugin_slug;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role_name) THEN
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
      v_role_name
    );
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema_name);
  EXECUTE format('GRANT CREATE, USAGE ON SCHEMA %I TO %I', v_schema_name, v_role_name);
  -- Membership, not blanket privilege — app_user can SET LOCAL ROLE to this plugin's
  -- role for the duration of one transaction (0019's app_user pattern), and gains no
  -- standing privilege on plugin_<slug> outside that.
  EXECUTE format('GRANT %I TO app_user', v_role_name);
END;
$$;

REVOKE ALL ON FUNCTION create_plugin_schema(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION create_plugin_schema(text) TO app_user;
  END IF;
END
$$;
