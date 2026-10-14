import { sql } from "drizzle-orm";
import { withTenantContext } from "@platform/db";

/**
 * #689: per-user erasure (apps/api/src/services/user-erasure.ts) finds the
 * comments to scrub through `metadata.mentions`, but third-party comments
 * arrive with identifiers, not user ids. Record each resolved user here, and
 * the identifier the commenter typed for them (#769): a login name is stored
 * nowhere else in the tenant, so this is the only way erasure can later find
 * it in the comment text. `metadata.mentionIdentifiers` maps user id to the
 * identifiers used for that user.
 *
 * Only tenant members are recorded: a non-member can't be erased from this
 * tenant, and a user erased before this job ran must not be linked back. One
 * statement, so concurrent jobs for the same comment can't drop each other's
 * ids — the second waits on the row lock and re-checks against the first's
 * result. A missing `mentions` key is treated as [], never NULL, because
 * jsonb_set with NULL would null the whole NOT NULL metadata column.
 */
export async function recordResolvedMention(
  tenantId: string,
  commentId: string,
  userId: string,
  identifier = "",
): Promise<void> {
  await withTenantContext(tenantId, (tx) =>
    tx.execute(sql`
      UPDATE workflow_events
      SET metadata = metadata || jsonb_build_object(
        'mentions',
        CASE
          WHEN COALESCE(metadata -> 'mentions', '[]'::jsonb) ? ${userId}::text
            THEN COALESCE(metadata -> 'mentions', '[]'::jsonb)
          ELSE COALESCE(metadata -> 'mentions', '[]'::jsonb) || to_jsonb(${userId}::text)
        END,
        'mentionIdentifiers',
        COALESCE(metadata -> 'mentionIdentifiers', '{}'::jsonb) || jsonb_build_object(
          ${userId}::text,
          CASE
            WHEN ${identifier}::text = ''
              OR COALESCE(metadata -> 'mentionIdentifiers' -> ${userId}::text, '[]'::jsonb) ? ${identifier}::text
              THEN COALESCE(metadata -> 'mentionIdentifiers' -> ${userId}::text, '[]'::jsonb)
            ELSE COALESCE(metadata -> 'mentionIdentifiers' -> ${userId}::text, '[]'::jsonb) || to_jsonb(${identifier}::text)
          END
        )
      )
      WHERE id = ${commentId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND metadata ->> 'type' = 'comment'
        AND jsonb_typeof(COALESCE(metadata -> 'mentions', '[]'::jsonb)) = 'array'
        AND jsonb_typeof(COALESCE(metadata -> 'mentionIdentifiers', '{}'::jsonb)) = 'object'
        AND jsonb_typeof(COALESCE(metadata -> 'mentionIdentifiers' -> ${userId}::text, '[]'::jsonb)) = 'array'
        AND EXISTS (
          SELECT 1 FROM tenant_users tu
          WHERE tu.tenant_id = ${tenantId}::uuid AND tu.user_id = ${userId}
        )
    `),
  );
}
