-- analytics: excluded (no new table — data-only update of workflow_events)
--
-- #689: per-user erasure finds the comments to scrub through
-- metadata.mentions. Third-party comments arrive with identifiers (email,
-- login name, user id), not user ids, so their mentions were never recorded
-- and erasure left the erased user's identifier in the text. From this
-- release the mention-resolution worker records each resolved user. This
-- backfills comments written before that, from the audit trail the worker
-- already wrote:
--   tag.auto_granted / tag.access_request_created / tag.misuse_rate_capped
--       -> metadata.grantedUserId
--   tag.resolved_existing_access / tag.fallback
--       -> metadata.mentionIdentifier matched to tenant_users.user_id or email
-- Only current tenant members are added: a user already erased has no
-- tenant_users row, and must not be linked back. Ids are appended once
-- (de-duplicated), and a missing mentions key becomes an array.
--
-- Must apply after 0132 (#763): the migrator skips a migration whose journal
-- timestamp is older than the newest one already applied.
--
-- Rollback: not needed for correctness (the ids only widen what a later
-- erasure scrubs). To undo, restore workflow_events.metadata from backup.

WITH resolved AS (
    SELECT DISTINCT
        a.tenant_id,
        (a.metadata ->> 'commentId')::uuid AS comment_id,
        tu.user_id
    FROM admin_audit_log a
    JOIN tenant_users tu
      ON tu.tenant_id = a.tenant_id
     AND (
          (a.action IN ('tag.auto_granted', 'tag.access_request_created',
                        'tag.misuse_rate_capped')
           AND tu.user_id = a.metadata ->> 'grantedUserId')
       OR (a.action IN ('tag.resolved_existing_access', 'tag.fallback')
           AND (tu.user_id = a.metadata ->> 'mentionIdentifier'
                OR lower(tu.email) = lower(a.metadata ->> 'mentionIdentifier')))
     )
    WHERE a.action IN ('tag.auto_granted', 'tag.access_request_created',
                       'tag.misuse_rate_capped', 'tag.resolved_existing_access',
                       'tag.fallback')
      AND a.metadata ->> 'commentId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
per_comment AS (
    SELECT tenant_id, comment_id, jsonb_agg(DISTINCT user_id) AS ids
    FROM resolved
    GROUP BY tenant_id, comment_id
)
UPDATE workflow_events we
SET metadata = jsonb_set(
    we.metadata,
    '{mentions}',
    COALESCE(we.metadata -> 'mentions', '[]'::jsonb)
    || (
        SELECT COALESCE(jsonb_agg(x.id), '[]'::jsonb)
        FROM jsonb_array_elements_text(pc.ids) AS x(id)
        WHERE NOT (COALESCE(we.metadata -> 'mentions', '[]'::jsonb) ? x.id)
    )
)
FROM per_comment pc
WHERE we.id = pc.comment_id
  AND we.tenant_id = pc.tenant_id
  AND we.metadata ->> 'type' = 'comment'
  AND jsonb_typeof(COALESCE(we.metadata -> 'mentions', '[]'::jsonb)) = 'array'
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(pc.ids) AS x(id)
      WHERE NOT (COALESCE(we.metadata -> 'mentions', '[]'::jsonb) ? x.id)
  );
