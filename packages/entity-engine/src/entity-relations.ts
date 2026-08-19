import { eq, and, or, asc, gt, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityRelations, entityInstances, workflowEvents } from "@platform/db";
import { logger } from "@platform/logger";
import type { EntityRelation } from "./types.js";
import { EntityError } from "./errors.js";
import {
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./pagination.js";
import type { CursorPage } from "./pagination.js";

export const RELATION_REFERENCES = "references";
export const RELATION_REFERENCED_BY = "referenced_by";

export type CreateRelationInput = {
  fromInstanceId: string;
  toInstanceId: string;
  relationType: string;
  actorId?: string | null;
};

export type CreateReferenceLinkInput = {
  fromInstanceId: string;
  toInstanceId: string;
  actorId?: string | null;
};

// ui-feature-checklist-and-rules.md §3.1/§3.2 — linking/unlinking must log a
// workflow_events row on BOTH tickets involved, not just a server log line.
// Mirrors apps/api/src/lib/emit-access-event.ts's resolveWorkflowContext
// (child tickets may have a null workflowId of their own; walk up to the
// parent's) — duplicated rather than imported since entity-engine's
// dependency rule is "db only" and that helper lives in apps/api.
async function resolveWorkflowContextForHistory(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<{ workflowId: string; currentState: string } | null> {
  const [row] = await db
    .select({
      workflowId: entityInstances.workflowId,
      currentState: entityInstances.currentState,
    })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!row) return null;

  let workflowId = row.workflowId;
  if (!workflowId) {
    const [parentRel] = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.fromInstanceId, instanceId),
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.relationType, "child_of"),
          isNull(entityRelations.deletedAt),
        ),
      )
      .limit(1);
    if (parentRel) {
      const [parent] = await db
        .select({ workflowId: entityInstances.workflowId })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, parentRel.toInstanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1);
      workflowId = parent?.workflowId ?? null;
    }
  }

  if (!workflowId) return null;
  return { workflowId, currentState: row.currentState };
}

type LinkHistoryType =
  | "link_created"
  | "link_removed"
  | "reference_created"
  | "reference_removed";

async function writeLinkHistoryEvent(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  counterpartId: string,
  relationType: string,
  actorId: string | null,
  type: LinkHistoryType,
): Promise<void> {
  try {
    const ctx = await resolveWorkflowContextForHistory(
      db,
      tenantId,
      instanceId,
    );
    if (!ctx) return;

    await db.insert(workflowEvents).values({
      tenantId,
      instanceId,
      workflowId: ctx.workflowId,
      fromState: ctx.currentState,
      toState: ctx.currentState,
      triggeredBy: "user",
      actorId,
      comment: null,
      metadata: { type, counterpartId, relationType },
    });
  } catch {
    // Best-effort — never block the main link/unlink operation.
  }
}

export type ListRelationsInput = {
  direction?: "from" | "to" | "both" | undefined;
  relationType?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export async function createRelation(
  db: DbOrTx,
  tenantId: string,
  input: CreateRelationInput,
): Promise<EntityRelation> {
  // Verify both instances exist, belong to this tenant, and are not soft-deleted
  const [fromInstance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, input.fromInstanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!fromInstance) {
    throw new EntityError("RELATION_TARGET_NOT_FOUND", {
      instanceId: input.fromInstanceId,
    });
  }

  const [toInstance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, input.toInstanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!toInstance) {
    throw new EntityError("RELATION_TARGET_NOT_FOUND", {
      instanceId: input.toInstanceId,
    });
  }

  const [row] = await db
    .insert(entityRelations)
    .values({
      tenantId,
      fromInstanceId: input.fromInstanceId,
      toInstanceId: input.toInstanceId,
      relationType: input.relationType,
    })
    .returning();

  if (!row) throw new EntityError("RELATION_NOT_FOUND", {});

  logger.info(
    { tenantId, relationId: row.id, relationType: input.relationType },
    "Entity relation created",
  );

  const actorId = input.actorId ?? null;
  await Promise.all([
    writeLinkHistoryEvent(
      db,
      tenantId,
      input.fromInstanceId,
      input.toInstanceId,
      input.relationType,
      actorId,
      "link_created",
    ),
    writeLinkHistoryEvent(
      db,
      tenantId,
      input.toInstanceId,
      input.fromInstanceId,
      input.relationType,
      actorId,
      "link_created",
    ),
  ]);

  return rowToRelation(row);
}

/**
 * Create a bidirectional, workflow-agnostic reference link between two
 * instances of any entity type / workflow / module. Unlike createChildRelation,
 * this performs no depth/cap/cycle validation — it is a pure navigational
 * pointer with no effect on either instance's workflow.
 */
export async function createReferenceLink(
  db: DbOrTx,
  tenantId: string,
  input: CreateReferenceLinkInput,
): Promise<{ relations: EntityRelation[] }> {
  const { fromInstanceId, toInstanceId } = input;

  if (fromInstanceId === toInstanceId) {
    throw new EntityError("RELATION_SELF_LINK", { instanceId: fromInstanceId });
  }

  const [fromInstance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, fromInstanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!fromInstance) {
    throw new EntityError("RELATION_TARGET_NOT_FOUND", {
      instanceId: fromInstanceId,
    });
  }

  const [toInstance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, toInstanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!toInstance) {
    throw new EntityError("RELATION_TARGET_NOT_FOUND", {
      instanceId: toInstanceId,
    });
  }

  const [existing] = await db
    .select({ id: entityRelations.id })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.fromInstanceId, fromInstanceId),
        eq(entityRelations.toInstanceId, toInstanceId),
        eq(entityRelations.relationType, RELATION_REFERENCES),
        isNull(entityRelations.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    throw new EntityError("RELATION_ALREADY_EXISTS", {
      fromInstanceId,
      toInstanceId,
    });
  }

  const relationRows = await db
    .insert(entityRelations)
    .values([
      {
        tenantId,
        fromInstanceId,
        toInstanceId,
        relationType: RELATION_REFERENCES,
      },
      {
        tenantId,
        fromInstanceId: toInstanceId,
        toInstanceId: fromInstanceId,
        relationType: RELATION_REFERENCED_BY,
      },
    ])
    .returning();

  logger.info(
    { tenantId, fromInstanceId, toInstanceId },
    "Reference link created",
  );

  const actorId = input.actorId ?? null;
  await Promise.all([
    writeLinkHistoryEvent(
      db,
      tenantId,
      fromInstanceId,
      toInstanceId,
      RELATION_REFERENCES,
      actorId,
      "reference_created",
    ),
    writeLinkHistoryEvent(
      db,
      tenantId,
      toInstanceId,
      fromInstanceId,
      RELATION_REFERENCES,
      actorId,
      "reference_created",
    ),
  ]);

  return { relations: relationRows.map(rowToRelation) };
}

export async function listRelations(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  input: ListRelationsInput = {},
): Promise<CursorPage<EntityRelation>> {
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const direction = input.direction ?? "both";

  const conditions = [
    eq(entityRelations.tenantId, tenantId),
    isNull(entityRelations.deletedAt),
  ];

  if (direction === "from") {
    conditions.push(eq(entityRelations.fromInstanceId, instanceId));
  } else if (direction === "to") {
    conditions.push(eq(entityRelations.toInstanceId, instanceId));
  } else {
    const dirCond = or(
      eq(entityRelations.fromInstanceId, instanceId),
      eq(entityRelations.toInstanceId, instanceId),
    );
    if (dirCond) conditions.push(dirCond);
  }

  if (input.relationType) {
    conditions.push(eq(entityRelations.relationType, input.relationType));
  }

  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      const cursorCond = or(
        gt(entityRelations.createdAt, decoded.createdAt),
        and(
          eq(entityRelations.createdAt, decoded.createdAt),
          gt(entityRelations.id, decoded.id),
        ),
      );
      if (cursorCond) conditions.push(cursorCond);
    }
  }

  const rows = await db
    .select()
    .from(entityRelations)
    .where(and(...conditions))
    .orderBy(asc(entityRelations.createdAt), asc(entityRelations.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return { data: data.map(rowToRelation), nextCursor };
}

/**
 * Load a reference relation row (references or referenced_by) scoped to the
 * tenant, for callers that need to authorize before deleting it.
 */
export async function getReferenceRelation(
  db: DbOrTx,
  tenantId: string,
  relationId: string,
): Promise<EntityRelation | null> {
  const [row] = await db
    .select()
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.id, relationId),
        eq(entityRelations.tenantId, tenantId),
        or(
          eq(entityRelations.relationType, RELATION_REFERENCES),
          eq(entityRelations.relationType, RELATION_REFERENCED_BY),
        ),
        isNull(entityRelations.deletedAt),
      ),
    )
    .limit(1);
  return row ? rowToRelation(row) : null;
}

/**
 * Soft-delete a reference link — both the given row and its mirrored
 * counterpart (references <-> referenced_by) on the other instance.
 */
export async function deleteReferenceLink(
  db: DbOrTx,
  tenantId: string,
  relationId: string,
  actorId?: string | null,
): Promise<void> {
  const relation = await getReferenceRelation(db, tenantId, relationId);
  if (!relation) throw new EntityError("RELATION_NOT_FOUND", { relationId });

  const mirrorType =
    relation.relationType === RELATION_REFERENCES
      ? RELATION_REFERENCED_BY
      : RELATION_REFERENCES;

  // Single UPDATE covering both the row and its mirror — atomic by
  // construction (no transaction needed), so a crash between "delete A's
  // side" and "delete B's side" can't leave one deleted and the other not
  // (the spec's §V invariant applies to deletion, not just creation).
  await db
    .update(entityRelations)
    .set({ deletedAt: sql`now()` })
    .where(
      or(
        eq(entityRelations.id, relation.id),
        and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, relation.toInstanceId),
          eq(entityRelations.toInstanceId, relation.fromInstanceId),
          eq(entityRelations.relationType, mirrorType),
          isNull(entityRelations.deletedAt),
        ),
      ),
    );

  logger.info(
    { tenantId, relationId: relation.id },
    "Reference link soft-deleted",
  );

  await Promise.all([
    writeLinkHistoryEvent(
      db,
      tenantId,
      relation.fromInstanceId,
      relation.toInstanceId,
      relation.relationType,
      actorId ?? null,
      "reference_removed",
    ),
    writeLinkHistoryEvent(
      db,
      tenantId,
      relation.toInstanceId,
      relation.fromInstanceId,
      relation.relationType,
      actorId ?? null,
      "reference_removed",
    ),
  ]);
}

export async function deleteRelation(
  db: DbOrTx,
  tenantId: string,
  relationId: string,
  actorId?: string | null,
): Promise<void> {
  const [existing] = await db
    .select({
      id: entityRelations.id,
      fromInstanceId: entityRelations.fromInstanceId,
      toInstanceId: entityRelations.toInstanceId,
      relationType: entityRelations.relationType,
    })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.id, relationId),
        eq(entityRelations.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!existing) throw new EntityError("RELATION_NOT_FOUND", { relationId });

  await db
    .update(entityRelations)
    .set({ deletedAt: sql`now()` })
    .where(eq(entityRelations.id, relationId));

  logger.info({ tenantId, relationId }, "Entity relation soft-deleted");

  await Promise.all([
    writeLinkHistoryEvent(
      db,
      tenantId,
      existing.fromInstanceId,
      existing.toInstanceId,
      existing.relationType,
      actorId ?? null,
      "link_removed",
    ),
    writeLinkHistoryEvent(
      db,
      tenantId,
      existing.toInstanceId,
      existing.fromInstanceId,
      existing.relationType,
      actorId ?? null,
      "link_removed",
    ),
  ]);
}

function rowToRelation(
  row: typeof entityRelations.$inferSelect,
): EntityRelation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    fromInstanceId: row.fromInstanceId,
    toInstanceId: row.toInstanceId,
    relationType: row.relationType,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}
