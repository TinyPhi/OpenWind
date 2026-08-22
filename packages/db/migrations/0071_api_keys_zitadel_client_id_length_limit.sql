-- analytics: excluded (no new table — constraint addition only)
--
-- Issue #451 (follow-up flagged during PR #439/#445 review): `zitadel_client_id`
-- was added as an unbounded `text` column by migration 0068, same as the three
-- columns migration 0070 already bounded (application_name/description/
-- contact_email). Out of scope for #445 at the time (that issue named only the
-- three application-metadata columns), tracked separately as #451. 200 matches
-- create.ts's existing Zod `.max(200)` bound on `zitadelClientId`.
--
-- Renumbered from 0070 to 0071 during a rebase -- main's tip claimed 0069/0070
-- first via PR #446/PR #452 (same precedent as the #445 migration's own
-- 0069->0070 renumber).
--
-- Stays nullable (unchanged from migration 0068) — Postgres CHECK constraints
-- pass automatically on NULL, so a key with no formal application record is
-- unaffected.
--
-- Runs in one transaction (no NOT VALID, per 0037/0070's established
-- reasoning) — validates every existing row, fails loudly rather than
-- silently truncating a Client ID (which would corrupt a real external
-- application's registered identifier). Audited before applying: zero rows
-- in `platform_test` have any zitadel_client_id populated at all as of this
-- migration.
--
-- Rollback:
--   ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_zitadel_client_id_length;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_zitadel_client_id_length
  CHECK (char_length(zitadel_client_id) <= 200);
