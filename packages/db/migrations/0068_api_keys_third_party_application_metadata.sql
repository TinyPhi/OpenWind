-- analytics: excluded (no new table — column additions only)
--
-- ADR-012 Phase A (Third-Party API — Key Management): a third-party API key
-- needs a formal application record (name/description/contact email/Zitadel
-- Client ID) so it stops being an anonymous credential — the contact email
-- unblocks a deferred expiry-notification fast-follow, and the Client ID is
-- what makes Phase B's `aud` audience check correct (ADR-012 Decision #1).
--
-- Deliberately NOT adding columns that already exist on api_keys from
-- ADR-008: `expires_at` (migration 0053), `revoked_at`/`revoked_by`
-- (migration 0053), `rotated_from` (migration 0053 lineage), `scopes`/
-- `scopes_format` (migrations ~0040s/0055). Phase A's spec listed these as
-- if new because it was written against the design doc in isolation, not
-- against the current schema — reusing them keeps a single source of truth
-- for expiry/rotation/scope-format instead of a second, competing set of
-- columns that could drift out of sync with the originals. See
-- docs/decisions/ADR-012-third-party-api-ticket-access.md and
-- docs/specs/third-party-api-phase-a-key-management.md.
--
-- `rotation_successor_id` (the spec's proposed reverse pointer) is likewise
-- not added — a predecessor's successor is discoverable via
-- `WHERE rotated_from = <predecessor id>`, so a second stored pointer would
-- just be a second place for predecessor/successor to disagree with each
-- other. Same for a stored `status` enum (active/rotating/expired/revoked,
-- per the spec's §I): it's fully derivable from `revoked_at`/`expires_at`/
-- `rotated_from` and is expected to be computed at the query/API layer
-- (Phase A's UI task, T8), not materialized here.
--
-- All four new columns are nullable — additive, no existing read/write path
-- breaks. NULL means "not a formally-registered third-party application key"
-- (i.e. every key minted before this phase, and any key minted going forward
-- through a path other than the new third-party key-management flow). The
-- mint endpoint (Phase A, T2) is what actually enforces these as required
-- for that specific flow — the DB layer allows NULL so this migration can't
-- break any existing key or any other code path that creates api_keys rows.
--
-- zitadel_client_id uniqueness (ADR-012 Decision #1, spec R7/§V): a partial
-- unique index scoped to `revoked_at IS NULL` — Postgres partial-index
-- predicates must be immutable, so `expires_at > now()` cannot appear in the
-- predicate itself (`now()` is stable, not immutable). This means the DB
-- constraint alone only excludes *revoked* keys from the uniqueness check,
-- not *expired-but-not-yet-revoked* ones. The mint endpoint (T2) must
-- therefore also explicitly check for an expired row holding the same
-- Client ID and treat it the same as "not in use" at the application layer,
-- rather than relying on the index to catch that case — flagged here so
-- T2's implementer doesn't assume the index alone is sufficient.
--
-- Rollback:
--   DROP INDEX IF EXISTS api_keys_zitadel_client_id_active_unique;
--   ALTER TABLE api_keys DROP COLUMN zitadel_client_id;
--   ALTER TABLE api_keys DROP COLUMN application_contact_email;
--   ALTER TABLE api_keys DROP COLUMN application_description;
--   ALTER TABLE api_keys DROP COLUMN application_name;

ALTER TABLE api_keys ADD COLUMN application_name text;
ALTER TABLE api_keys ADD COLUMN application_description text;
ALTER TABLE api_keys ADD COLUMN application_contact_email text;
ALTER TABLE api_keys ADD COLUMN zitadel_client_id text;

CREATE UNIQUE INDEX api_keys_zitadel_client_id_active_unique
  ON api_keys (zitadel_client_id)
  WHERE revoked_at IS NULL AND zitadel_client_id IS NOT NULL;
