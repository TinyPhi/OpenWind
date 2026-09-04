-- analytics: excluded (nullable provenance columns, not an analytics dimension)
--
-- docs/specs/third-party-api-origin-tagging.md, Phase 1 (T2). Adds origin-tracking
-- columns to entity_instances (ticket/sub-ticket-level tag, R1/R2/R4) and
-- workflow_events (comment + activity-timeline tag, R3/R5 -- comments are stored as
-- workflow_events rows, not a separate table; see comments.ts's own insert).
--
-- origin_oidc_client_id deliberately has NO foreign key to api_keys.oidc_client_id --
-- that column isn't unique/PK (it changes identity across a key's rotation lineage but
-- the same value can appear on multiple historical rows), and per the spec's own §C,
-- the live application name is resolved by joining to whichever api_keys row is
-- CURRENTLY active for that client id at read time, not pinned to one historical row.
-- Validity (does this client id correspond to a real registered application) is
-- enforced at the write path (Phase 2, T5/T7), not by a DB constraint here.
--
-- Nullable on all three: NULL/NULL/NULL means human, in-app creation (no tag rendered,
-- per spec §V). The CHECK below enforces the invariant that origin_mechanism can only
-- ever be set together with both other columns, or not set at all -- never a partial
-- origin (spec §V: "ALWAYS has a non-null, resolvable app+performer identity ... or
-- not silently created untagged").
--
-- Rollback (undoes only what THIS migration added):
--   ALTER TABLE entity_instances DROP CONSTRAINT entity_instances_origin_all_or_nothing;
--   ALTER TABLE entity_instances DROP COLUMN origin_mechanism;
--   ALTER TABLE entity_instances DROP COLUMN origin_oidc_client_id;
--   ALTER TABLE entity_instances DROP COLUMN origin_performer_user_id;
--   ALTER TABLE workflow_events DROP CONSTRAINT workflow_events_origin_all_or_nothing;
--   ALTER TABLE workflow_events DROP COLUMN origin_mechanism;
--   ALTER TABLE workflow_events DROP COLUMN origin_oidc_client_id;
--   ALTER TABLE workflow_events DROP COLUMN origin_performer_user_id;

ALTER TABLE entity_instances
  ADD COLUMN origin_mechanism text,
  ADD COLUMN origin_oidc_client_id text,
  ADD COLUMN origin_performer_user_id text;

ALTER TABLE entity_instances
  ADD CONSTRAINT entity_instances_origin_mechanism_check
    CHECK (origin_mechanism IN ('api', 'handoff') OR origin_mechanism IS NULL);

ALTER TABLE entity_instances
  ADD CONSTRAINT entity_instances_origin_all_or_nothing
    CHECK (
      (origin_mechanism IS NULL AND origin_oidc_client_id IS NULL AND origin_performer_user_id IS NULL)
      OR
      (origin_mechanism IS NOT NULL AND origin_oidc_client_id IS NOT NULL AND origin_performer_user_id IS NOT NULL)
    );

ALTER TABLE workflow_events
  ADD COLUMN origin_mechanism text,
  ADD COLUMN origin_oidc_client_id text,
  ADD COLUMN origin_performer_user_id text;

ALTER TABLE workflow_events
  ADD CONSTRAINT workflow_events_origin_mechanism_check
    CHECK (origin_mechanism IN ('api', 'handoff') OR origin_mechanism IS NULL);

ALTER TABLE workflow_events
  ADD CONSTRAINT workflow_events_origin_all_or_nothing
    CHECK (
      (origin_mechanism IS NULL AND origin_oidc_client_id IS NULL AND origin_performer_user_id IS NULL)
      OR
      (origin_mechanism IS NOT NULL AND origin_oidc_client_id IS NOT NULL AND origin_performer_user_id IS NOT NULL)
    );
