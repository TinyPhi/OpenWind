import { eq, and, or, asc, gt, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityRelations, entityInstances } from "@platform/db";
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

export type CreateRelationInput = {
  fromInstanceId: string;
  toInstanceId: string;
  relationType: string;
};

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

  return rowToRelation(row);
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

export async function deleteRelation(
  db: DbOrTx,
  tenantId: string,
  relationId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: entityRelations.id })
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
