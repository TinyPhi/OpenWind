-- analytics: excluded (no new table — constraint additions only)
--
-- Issue #445 (found during PR #439 review): migration 0068 added
-- `application_name`/`application_description`/`application_contact_email` as
-- unbounded `text` columns. The API layer (create.ts's Zod schema) already
-- bounded `application_name` (200) and `application_description` (2000), but
-- nothing bounded `application_contact_email`, and nothing stopped a direct
-- DB write (or a future code path that bypasses the API) from inserting an
-- arbitrarily large value into any of the three. These CHECK constraints are
-- the DB-layer half of the fix — defense-in-depth, not a replacement for the
-- matching Zod bound added in the same PR.
--
-- 320 for the email column is RFC 5321's maximum total address length
-- (64 local-part + 1 "@" + 255 domain).
--
-- All three columns stay nullable (unchanged from migration 0068) — Postgres
-- CHECK constraints pass automatically on NULL, so a key with no formal
-- application record (every pre-Phase-A key, and any non-third-party key)
-- is unaffected.
--
-- This migration runs in one transaction (this migrator's convention, per
-- 0037's own comment on why NOT VALID buys nothing here) and does NOT use
-- NOT VALID, so ALTER TABLE ADD CONSTRAINT validates every existing row and
-- fails the whole migration if any row already violates a bound. This is
-- deliberate, not an oversight: `application_contact_email` was unbounded at
-- the API layer from migration 0068 (PR #439) until this same PR closed that
-- gap in create.ts, so a pre-existing over-320-char email is a real
-- (if narrow — the endpoint has only been live since 2026-08-20) possibility
-- in some environment. A silent truncation instead would corrupt a contact
-- email into a shorter, undeliverable string — worse than a loud migration
-- failure that lets an operator inspect and manually fix the specific
-- offending row(s) first. Dev row counts are trivial (0 rows with any
-- application metadata column populated in `platform_test`, checked as of
-- this migration) — see 0037's own "Dev row counts are trivial" precedent.
-- Per that same precedent, run the equivalent `char_length(...) > N` audit
-- query against any environment's real data before applying this migration
-- there, in case production scale tells a different story.
--
-- `zitadel_client_id` (also added unbounded by migration 0068, also
-- Zod-bounded at 200 chars in create.ts) is deliberately NOT given a
-- matching CHECK here — out of scope for issue #445, which named only the
-- three application-metadata columns above. Tracked as a follow-up:
-- issue #451.
--
-- Rollback:
--   ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_application_contact_email_length;
--   ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_application_description_length;
--   ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_application_name_length;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_application_name_length
  CHECK (char_length(application_name) <= 200);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_application_description_length
  CHECK (char_length(application_description) <= 2000);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_application_contact_email_length
  CHECK (char_length(application_contact_email) <= 320);
