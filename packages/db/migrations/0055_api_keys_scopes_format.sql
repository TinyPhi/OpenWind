-- analytics: excluded (no new table — single column addition)
--
-- ADR-008 Decision #6: introduce a discriminator for api_keys.scopes so the
-- format re-shape (role-strings -> entity:<entityType>:<verb> action-strings,
-- ADR-010's Tier-1 prerequisite) can be told apart without a colon heuristic
-- or a date cutoff, both of which break the moment a future role-string
-- happens to contain a colon or a key is created near the cutoff instant.
--
-- Every existing and newly-created key defaults to 'role' — this migration
-- does not migrate any existing key's scopes content, and no code path yet
-- writes 'action' (see packages/auth/src/scopes.ts's detectScopesFormat and
-- apps/api/src/routes/api-keys/create.ts, which computes the column from the
-- scopes actually supplied; scope-ceiling.ts still rejects any non-role-string
-- scope today, so in practice 'action' cannot be produced until that ceiling
-- check is deliberately reopened once OQ-5's verb set and #365's redactor
-- both exist).
--
-- Rollback:
--   ALTER TABLE api_keys DROP COLUMN scopes_format;

ALTER TABLE api_keys ADD COLUMN scopes_format text NOT NULL DEFAULT 'role';

ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_format_check
  CHECK (scopes_format IN ('role', 'action'));
