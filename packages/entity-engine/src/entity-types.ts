import { eq, and, asc, gt, or, isNull, count } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityTypes, entityInstances } from "@platform/db";
import { logger } from "@platform/logger";
import type { EntityType } from "./types.js";
import { EntityError } from "./errors.js";
import { addEntityField } from "./engine.js";
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

  // Mandatory-ticket-fields sync, 2026-09-21 -- guarantee every new,
  // per-tenant entity type has at least a required "title" field from the
  // moment it's created, rather than leaving that to the admin's separate,
  // optional "add fields" step afterward (apps/admin-ui's workflow-create
  // page never called that step automatically, so plenty of real workflows
  // ended up with no required custom field at all, or an arbitrary set of
  // their own instead of the intended title-is-the-one-mandatory-field
  // baseline). Does not touch what other fields the admin adds afterward or
  // whether they mark them required too -- this only guarantees the floor.
  // Skipped for module-catalog entity types (tenantId === null): those come
  // from seed SQL (modules/*.sql) which defines its own fields explicitly,
  // per ADR-004's config-first module model. Also skipped when this entity
  // type was created with allowCustomFields: false -- addEntityField itself
  // enforces that flag (engine.ts, CUSTOM_FIELDS_NOT_ALLOWED) and would
  // throw here otherwise, turning a locked-down entity type's creation into
  // a hard failure (/review finding, 2026-09-21). An allowCustomFields:false
  // entity type is intentionally locked down, same reasoning as the
  // module-catalog skip above -- it doesn't get either auto-seeded field.
  const allowCustomFields = input.allowCustomFields ?? true;
  if (tenantId !== null && allowCustomFields) {
    await addEntityField(db, tenantId, row.id, {
      entityTypeId: row.id,
      name: "title",
      label: "Title",
      fieldType: "text",
      config: {},
      isRequired: true,
      isIndexed: true,
      isSystem: false,
      sortOrder: 0,
      sensitivity: "public",
      createdAt: new Date(),
    });

    // Team-assign sync, 2026-09-21 (docs/specs/team-assign-oncall-fallback.md
    // R2) -- guarantee every new, per-tenant entity type has a team_id field
    // available from creation, mirroring the title auto-seed above. Always
    // optional (never isRequired: true): a ticket assigned by user has no
    // team, and by design exactly one of assignedTo/teamId is ever set (see
    // apps/api/src/routes/entities/create.ts's CreateEntitySchema refinement)
    // -- forcing team_id required would break that exclusivity. fieldType is
    // plain "text" (holds a teams.id UUID string), not "entity_ref": that
    // type validates against entity_instances, and teams is a separate
    // lookup table, not an entity type. This field is deliberately never
    // rendered via FieldInput on either ticket-creation form (excluded from
    // both the Mandate and Other tabs) -- its value is written exclusively
    // through the create form's User/Team assign-mode toggle.
    await addEntityField(db, tenantId, row.id, {
      entityTypeId: row.id,
      name: "team_id",
      label: "Team",
      fieldType: "text",
      config: {},
      isRequired: false,
      isIndexed: true,
      isSystem: false,
      sortOrder: 1,
      sensitivity: "public",
      createdAt: new Date(),
    });
  }

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
