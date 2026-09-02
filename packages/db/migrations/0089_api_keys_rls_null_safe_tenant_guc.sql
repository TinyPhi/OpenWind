-- analytics: excluded (RLS policy fix only — no new table)
--
-- Fixes a real production bug: api_keys' tenant_read/tenant_write RLS
-- policies cast current_setting('app.tenant_id', true) directly to ::uuid.
-- current_setting(name, missing_ok=true) returns NULL the *first* time a
-- custom GUC is read on a given backend connection, but once that GUC has
-- been SET (even SET LOCAL, even if the transaction later commits/rolls
-- back) on that same connection, later reads on that connection return ''
-- (empty string) instead of NULL — the GUC's "reset" value, not an unset
-- state. ''::uuid throws `invalid input syntax for type uuid: ""` instead
-- of the NULL comparison RLS expects (which would just filter every row).
--
-- api_keys is the one table with a documented, deliberate bare/unscoped
-- query that runs outside withTenantContext (apps/api/src/routes/api-keys/
-- create.ts's Client-ID uniqueness check — a Zitadel Client ID identifies
-- one external application, not one tenant's registration of it, so this
-- check is intentionally cross-tenant; see that file's own comment).
-- requireAuth() (packages/auth/src/middleware.ts) always runs its own
-- withTenantContext block first (to upsert tenant_users) on every
-- authenticated request, which "poisons" that backend connection's
-- app.tenant_id GUC into the '' state for any later bare query on the same
-- connection — reliably reproduced end-to-end (not caught by
-- create.test.ts, which mocks the DB entirely and never exercises real
-- Postgres GUC semantics), but never reproduced by mocked unit tests or by
-- any query that always sets its own tenant_id immediately before running
-- (which is every other query in the codebase — this bug is latent
-- elsewhere but only manifests for a bare, cross-tenant query pattern).
--
-- Fix: nullif(current_setting(...), '') collapses the empty-string reset
-- value back to NULL before the ::uuid cast, matching the "no tenant
-- context set" semantics RLS already expects and safely filters on.
--
-- Rollback (undoes only what THIS migration added):
--   DROP POLICY tenant_read ON api_keys;
--   DROP POLICY tenant_write ON api_keys;
--   CREATE POLICY tenant_read ON api_keys
--     FOR SELECT
--     USING (tenant_id = current_setting('app.tenant_id', true)::UUID);
--   CREATE POLICY tenant_write ON api_keys
--     FOR ALL
--     USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
--     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

DROP POLICY tenant_read ON api_keys;
DROP POLICY tenant_write ON api_keys;

CREATE POLICY tenant_read ON api_keys
  FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::UUID);

CREATE POLICY tenant_write ON api_keys
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::UUID)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::UUID);
