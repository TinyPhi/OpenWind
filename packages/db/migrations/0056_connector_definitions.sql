-- analytics: excluded (platform catalog metadata / tenant-scoped credential
-- ciphertext — neither has analytics value; connector_credentials was already
-- excluded by 0009_analytics_user_grants.sql and stays excluded)
-- down:
--   REVOKE SELECT ON connector_definitions FROM app_user;
--   DROP TABLE IF EXISTS connector_definitions;
--   ALTER TABLE connector_credentials DROP CONSTRAINT IF EXISTS connector_credentials_tenant_connector_unique;
--   ALTER TABLE connector_credentials DROP COLUMN IF EXISTS cursor_state;
--   ALTER TABLE connector_credentials ADD COLUMN credentials text NOT NULL DEFAULT '';
--   ALTER TABLE connector_credentials ALTER COLUMN credentials DROP DEFAULT;
--   ALTER TABLE connector_credentials DROP COLUMN IF EXISTS secrets;
--   ALTER TABLE connector_credentials ALTER COLUMN connector_id TYPE text USING connector_id::text;

-- ADR-009 Decision #8 / ADR-001 (multitenancy, "Non-tenant-scoped tables"):
-- connector_definitions is the platform-wide connector catalog read by the
-- marketplace UI (browse/install/configure) — declarative metadata only
-- (name, version, category, egress allowlist snapshot for display). It is
-- explicitly named in ADR-001 alongside tenants/modules/entity_types/
-- workflow_templates as platform-wide, RLS-disabled, app_user-read-only.
--
-- `triggers`/`actions` (packages/connector-sdk's TriggerDefinition[]/
-- ActionDefinition[]) are NOT columns here — they carry functions, not
-- serializable data, and stay in the connector's TypeScript definition.
-- This table is catalog-listing metadata only, matching `modules`' pattern.
--
-- `allowed_hosts` is a snapshot of ConnectorDefinition.allowedHosts for
-- marketplace display/audit — NOT a second enforcement point. The actual
-- egress allowlist enforcement happens in
-- packages/connector-sdk/src/runtime.ts's callApi(), against the
-- connector's own definition object.
--
-- No connector rows are seeded here — no real connector code exists yet
-- (separate future issue per each connector, e.g. email/WhatsApp).
CREATE TABLE connector_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  description     TEXT,
  icon_url        TEXT,
  docs_url        TEXT,
  category        TEXT NOT NULL CHECK (category IN (
                    'communication', 'finance', 'crm', 'hr', 'storage',
                    'ecommerce', 'other'
                  )),
  allowed_hosts   TEXT[] NOT NULL,
  is_visible      BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE connector_definitions IS
  'ADR-001/ADR-009: platform-wide connector catalog. No tenant_id/RLS — writable only by migration_user/admin-role endpoints, matching modules/entity_types.';

-- No RLS: platform-wide catalog table, per ADR-001. Readable by app_user;
-- writes are migration_user-only (no INSERT/UPDATE/DELETE grant below), same
-- restriction as modules/platform_settings' catalog rows.
GRANT SELECT ON connector_definitions TO app_user;

-- connector_credentials has existed since 0000_initial_schema.sql /
-- 0001_rls_and_tenancy.sql, scaffolded long before ADR-009/#362/#363 existed
-- and, confirmed via a full-codebase check, never actually read from or
-- written to by any real code path -- its one live consumer,
-- apps/worker/src/tenant-purge.ts, only ever runs a tenant_id-filtered
-- delete, never touching connector_id/credentials directly, so that delete
-- step is unaffected by the column changes below and needs no code change.
-- It is not a hypothetical: every environment's actual row count is (and
-- always has been) zero.
--
-- Reshaping it here (rather than creating a second, differently-named table)
-- matches ADR-009 Decision #8 and docs/roadmap.md's explicit "Install =
-- create connector_credentials row" naming, and gives #362's
-- ConnectorContext/ConnectorAuthConfig (packages/connector-sdk/src/types.ts)
-- a real backing store: secrets is a JSONB map of credentialKey -> OpenBao
-- ciphertext, matching runtime.ts's encryptedCredentials parameter exactly.
--
-- RLS policies (tenant_read/tenant_write, migration 0001) and the app_user
-- grant (SELECT/INSERT/UPDATE/DELETE, migration 0019) are deliberately left
-- untouched -- tenant-purge's delete step depends on the existing grant, and
-- there is no reason to touch working RLS.
--
-- connector_id's retype is written defensively (checking existing values
-- fit the uuid cast, and checking the new unique constraint first) even
-- though no environment has ever populated this table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM connector_credentials
    WHERE connector_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION
      'connector_credentials has connector_id values that are not valid UUIDs -- cannot proceed with the uuid retype. Resolve manually before re-running this migration.';
  END IF;

  IF EXISTS (
    SELECT tenant_id, connector_id
    FROM connector_credentials
    GROUP BY tenant_id, connector_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'connector_credentials has duplicate (tenant_id, connector_id) pairs -- cannot add the unique constraint. Resolve manually before re-running this migration.';
  END IF;
END
$$;

ALTER TABLE connector_credentials
  ALTER COLUMN connector_id TYPE UUID USING connector_id::uuid;

ALTER TABLE connector_credentials
  ADD CONSTRAINT connector_credentials_connector_id_fkey
  FOREIGN KEY (connector_id) REFERENCES connector_definitions(id);

-- No real credentials data has ever existed (see above) -- dropping instead
-- of attempting a text-to-jsonb data conversion.
ALTER TABLE connector_credentials DROP COLUMN credentials;
ALTER TABLE connector_credentials ADD COLUMN secrets JSONB NOT NULL DEFAULT '{}';

ALTER TABLE connector_credentials ADD COLUMN cursor_state JSONB;

ALTER TABLE connector_credentials
  ADD CONSTRAINT connector_credentials_tenant_connector_unique
  UNIQUE (tenant_id, connector_id);

COMMENT ON TABLE connector_credentials IS
  'ADR-009 Decision #8 / issue #363: tenant-scoped connector installation row -- secrets is a credentialKey->ciphertext JSONB map (see packages/connector-sdk/src/types.ts ConnectorAuthConfig), cursor_state is 1:1 polling-cursor state (Decision #7). RLS via migration 0001''s tenant_read/tenant_write policies (unchanged).';
