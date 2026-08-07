import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityInstances, entityRelations } from "@platform/db";
import { logger } from "@platform/logger";
import { EntityError } from "./errors.js";
import type { ArchiveResult } from "./types.js";
import { RELATION_PARENT_OF } from "./child-relations.js";

/**
 * Archive a ticket (and optionally all its descendants).
 *
 * - If the ticket has active children and `confirm` is false, returns
 *   `{ requiresConfirm: true, childCount }` without writing anything.
 * - If `confirm` is true, sets `deleted_at = now()` on the ticket and all
 *   descendants in a single transaction, and soft-deletes linking relations.
 */
export async function archiveEntity(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  confirm = false,
): Promise<ArchiveResult> {
  const [instance] = await db
    .select({ id: entityInstances.id, deletedAt: entityInstances.deletedAt })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!instance || instance.deletedAt) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId });
  }

  // Collect all active descendant IDs
  const descendantIds = await collectActiveDescendants(
    db,
    tenantId,
    instanceId,
  );

  if (descendantIds.length > 0 && !confirm) {
    return { requiresConfirm: true, childCount: descendantIds.length };
  }

  const allIds = [instanceId, ...descendantIds];
  const archiveTs = new Date();

  // Set deleted_at on all instances in the tree
  await db
    .update(entityInstances)
    .set({ deletedAt: archiveTs })
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        inArray(entityInstances.id, allIds),
        isNull(entityInstances.deletedAt),
      ),
    );

  // Soft-delete all entity_relations where both endpoints are in the tree
  // (covers parent_of + child_of pairs linking the archived nodes)
  await db
    .update(entityRelations)
    .set({ deletedAt: archiveTs })
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        inArray(entityRelations.fromInstanceId, allIds),
        isNull(entityRelations.deletedAt),
      ),
    );

  // The archived root's own parent_of relation (from its parent, if any)
  // has fromInstanceId = parent, which is outside allIds — the update above
  // never touches it. Left undeleted, countActiveChildren on the parent
  // keeps counting this archived root as an active child forever.
  await db
    .update(entityRelations)
    .set({ deletedAt: archiveTs })
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.toInstanceId, instanceId),
        eq(entityRelations.relationType, RELATION_PARENT_OF),
        isNull(entityRelations.deletedAt),
      ),
    );

  // Cascade-cancel (docs/specs/due-date.md R6): pending overdue triggers for
  // any archived instance in the tree must never fire.
  await db.execute(sql`
    UPDATE outbox_events
    SET delivered_at = now()
    WHERE delivered_at IS NULL
      AND event_type = 'entity.due_date_scheduled'
      AND tenant_id = ${tenantId}
      AND payload ->> 'instanceId' = ANY(ARRAY[${sql.join(
        allIds.map((id) => sql`${id}`),
        sql`, `,
      )}])
  `);

  logger.info(
    { tenantId, instanceId, descendantCount: descendantIds.length },
    "Entity archived with descendants",
  );

  return { archived: true, count: allIds.length };
}

/**
 * Restore a ticket and all descendants that were archived in the same batch
 * (identified by matching `deleted_at` timestamp).
 *
 * Descendants archived independently at a different time are left untouched.
 */
export async function restoreEntity(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<{ restored: true; count: number }> {
  const [instance] = await db
    .select({ id: entityInstances.id, deletedAt: entityInstances.deletedAt })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!instance) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });
  if (!instance.deletedAt) {
    throw new EntityError("ENTITY_NOT_FOUND", {
      instanceId,
      reason: "not archived",
    });
  }

  const archiveTs = instance.deletedAt;

  // Walk the relation chain including soft-deleted relations to find all
  // descendants that were archived in the same batch
  const batchDescendants = await collectBatchDescendants(
    db,
    tenantId,
    instanceId,
    archiveTs,
  );

  const allIds = [instanceId, ...batchDescendants];

  // Restore instances
  await db
    .update(entityInstances)
    .set({ deletedAt: null })
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        inArray(entityInstances.id, allIds),
        // Only restore those from the same archive batch
        sql`${entityInstances.deletedAt} = ${archiveTs}`,
      ),
    );

  // Restore the linking relations
  await db
    .update(entityRelations)
    .set({ deletedAt: null })
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        inArray(entityRelations.fromInstanceId, allIds),
        sql`${entityRelations.deletedAt} = ${archiveTs}`,
      ),
    );

  // The restored root's own inbound parent_of relation (fromInstanceId =
  // parent, which is outside allIds) was severed by archiveEntity's own
  // dedicated fix-up step and is never touched by the update above — mirror
  // that same fix-up here, or restore-then-archive leaves the relation graph
  // asymmetric (parent's countActiveChildren never sees this root again).
  await db
    .update(entityRelations)
    .set({ deletedAt: null })
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.toInstanceId, instanceId),
        eq(entityRelations.relationType, RELATION_PARENT_OF),
        sql`${entityRelations.deletedAt} = ${archiveTs}`,
      ),
    );

  logger.info(
    { tenantId, instanceId, restoredCount: allIds.length },
    "Entity restored with descendants",
  );

  return { restored: true, count: allIds.length };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** BFS over active (non-soft-deleted) parent_of relations. */
async function collectActiveDescendants(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<string[]> {
  const result: string[] = [];
  const queue = [instanceId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const children = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_PARENT_OF),
          isNull(entityRelations.deletedAt),
        ),
      );
    for (const c of children) {
      result.push(c.toInstanceId);
      queue.push(c.toInstanceId);
    }
  }
  return result;
}

/**
 * BFS over parent_of relations (including soft-deleted) to find descendants
 * that share the same archive timestamp — i.e. were archived in the same batch.
 */
async function collectBatchDescendants(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  archiveTs: Date,
): Promise<string[]> {
  const result: string[] = [];
  const queue = [instanceId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const children = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_PARENT_OF),
          sql`${entityRelations.deletedAt} = ${archiveTs}`,
        ),
      );
    for (const c of children) {
      // Only include if this child was archived in the same batch
      const [inst] = await db
        .select({ deletedAt: entityInstances.deletedAt })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, c.toInstanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1);
      if (inst?.deletedAt?.getTime() === archiveTs.getTime()) {
        result.push(c.toInstanceId);
        queue.push(c.toInstanceId);
      }
    }
  }
  return result;
}
