-- analytics: excluded (no new table — column addition only)
--
-- ADR-012 Phase B, spec R9 / Round 7 GAP-05: a third-party API request
-- carries two identities (the application's key + a specific real person),
-- but admin_audit_log's actor_type CHECK ('user'|'api_key'|'system') plus a
-- single actor_id column has nowhere to record the person distinctly from
-- the key — searching by person or by key must both work independently.
-- Nullable and additive: every existing row (actor_type 'user'/'system',
-- and any pre-Phase-B 'api_key' row) is unaffected, acting_person_id simply
-- stays NULL for those.
--
-- Rollback:
--   ALTER TABLE admin_audit_log DROP COLUMN acting_person_id;

ALTER TABLE admin_audit_log ADD COLUMN acting_person_id text;
