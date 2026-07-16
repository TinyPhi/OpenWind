import { eq, and, asc, gt, or, isNull, count } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityTypes, entityInstances } from "@platform/db";
import { logger } from "@platform/logger";
import type { EntityType } from "./types.js";
import { EntityError } from "./errors.js";
import {
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./pagination.js";
import type { CursorPage } from "./pagination.js";

export type CreateEntityTypeInput = {
  name: string;
  plural: string;
  icon?: string | undefined;
  moduleId?: string | undefined;
  allowCustomFields?: boolean | undefined;
};

export type UpdateEntityTypeInput = {
  name?: string | undefined;
  plural?: string | undefined;
  icon?: string | null | undefined;
  allowCustomFields?: boolean | undefined;
};

export type ListEntityTypesInput = {
  moduleId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export async function createEntityType(
  db: DbOrTx,
  tenantId: string | null,
  input: CreateEntityTypeInput,
): Promise<EntityType> {
  const [row] = await db
    .insert(entityTypes)
    .values({
      tenantId,
      name: input.name,
      plural: input.plural,
      icon: input.icon ?? null,
      moduleId: input.moduleId ?? null,
      allowCustomFields: input.allowCustomFields ?? true,
    })
    .returning();

  if (!row) throw new EntityError("ENTITY_TYPE_NOT_FOUND");

  logger.info(
    { tenantId, entityTypeId: row.id, name: row.name },
    "Entity type created",
  );

  return rowToEntityType(row);
}

export async function getEntityType(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
): Promise<EntityType> {
  const [row] = await db
    .select()
    .from(entityTypes)
    .where(
      and(
        eq(entityTypes.id, entityTypeId),
        or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)),
      ),
    )
    .limit(1);

  if (!row) throw new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId });

  return rowToEntityType(row);
}

export async function listEntityTypes(
  db: DbOrTx,
  tenantId: string,
  input: ListEntityTypesInput = {},
): Promise<CursorPage<EntityType>> {
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const conditions = [
    or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)),
  ];

  if (input.moduleId !== undefined) {
    conditions.push(eq(entityTypes.moduleId, input.moduleId));
  }
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      const cursorCond = or(
        gt(entityTypes.createdAt, decoded.createdAt),
        and(
          eq(entityTypes.createdAt, decoded.createdAt),
          gt(entityTypes.id, decoded.id),
        ),
      );
      if (cursorCond) conditions.push(cursorCond);
    }
  }

  const rows = await db
    .select()
    .from(entityTypes)
    .where(and(...conditions))
    .orderBy(asc(entityTypes.createdAt), asc(entityTypes.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return { data: data.map(rowToEntityType), nextCursor };
}

export async function updateEntityType(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
  input: UpdateEntityTypeInput,
): Promise<EntityType> {
  const [existing] = await db
    .select()
    .from(entityTypes)
    .where(
      and(
        eq(entityTypes.id, entityTypeId),
        or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)),
      ),
    )
    .limit(1);

  if (!existing)
    throw new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId });

  const updates: Partial<typeof entityTypes.$inferInsert> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.plural !== undefined) updates.plural = input.plural;
  if ("icon" in input) updates.icon = input.icon ?? null;
  if (input.allowCustomFields !== undefined) {
    updates.allowCustomFields = input.allowCustomFields;
  }

  if (Object.keys(updates).length === 0) return rowToEntityType(existing);

  // Belt-and-suspenders: repeat the ownership condition already proven by the
  // SELECT above directly on the mutation statement itself. entity_types has
  // no RLS, so this is the only guard against a cross-tenant mutation if the
  // pre-check above is ever bypassed or refactored out.
  const [row] = await db
    .update(entityTypes)
    .set(updates)
    .where(
      and(
        eq(entityTypes.id, entityTypeId),
        or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)),
      ),
    )
    .returning();

  if (!row) throw new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId });

  logger.info({ tenantId, entityTypeId }, "Entity type updated");

  return rowToEntityType(row);
}

export async function deleteEntityType(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(
      and(
        eq(entityTypes.id, entityTypeId),
        or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)),
      ),
    )
    .limit(1);

  if (!existing)
    throw new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId });

  const [instanceCount] = await db
    .select({ count: count() })
    .from(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));

  if (instanceCount && instanceCount.count > 0) {
    throw new EntityError("ENTITY_TYPE_HAS_INSTANCES", {
      entityTypeId,
      count: instanceCount.count,
    });
  }

  // Belt-and-suspenders: see comment in updateEntityType above.
  await db
    .delete(entityTypes)
    .where(
      and(
        eq(entityTypes.id, entityTypeId),
        or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)),
      ),
    );

  logger.info({ tenantId, entityTypeId }, "Entity type deleted");
}

function rowToEntityType(row: typeof entityTypes.$inferSelect): EntityType {
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    name: row.name,
    plural: row.plural,
    icon: row.icon ?? null,
    moduleId: row.moduleId ?? null,
    allowCustomFields: row.allowCustomFields,
    createdAt: row.createdAt,
  };
}
