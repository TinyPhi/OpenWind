import { sql } from "drizzle-orm";
import { withTenantContext } from "@platform/db";

/**
 * #689: per-user erasure (apps/api/src/services/user-erasure.ts) finds the
 * comments to scrub through `metadata.mentions`, but third-party comments
 * arrive with identifiers, not user ids. Record each resolved user here.
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
): Promise<void> {
  await withTenantContext(tenantId, (tx) =>
    tx.execute(sql`
      UPDATE workflow_events
      SET metadata = jsonb_set(
        metadata,
        '{mentions}',
        COALESCE(metadata -> 'mentions', '[]'::jsonb) || to_jsonb(${userId}::text)
      )
      WHERE id = ${commentId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND metadata ->> 'type' = 'comment'
        AND jsonb_typeof(COALESCE(metadata -> 'mentions', '[]'::jsonb)) = 'array'
        AND NOT (COALESCE(metadata -> 'mentions', '[]'::jsonb) ? ${userId}::text)
        AND EXISTS (
          SELECT 1 FROM tenant_users tu
          WHERE tu.tenant_id = ${tenantId}::uuid AND tu.user_id = ${userId}
        )
    `),
  );
}
