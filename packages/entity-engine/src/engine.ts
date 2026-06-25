import { eq, and, asc, gt, isNull, or, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityInstances,
  entityTypes,
  entityFields,
  workflows,
  workflowStates,
  workflowEvents,
} from "@platform/db";
import { logger } from "@platform/logger";
import type {
  EntityInstance,
  EntityType,
  EntityField,
  CreateEntityInput,
  UpdateEntityInput,
  ListEntitiesInput,
  BulkCreateResult,
  BulkUpdateResult,
  BulkSetStateResult,
} from "./types.js";
import {
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./pagination.js";
import type { CursorPage } from "./pagination.js";
import { EntityError, ValidationError } from "./errors.js";
import type { FieldError } from "./errors.js";
import {
  getValidationSchema,
  invalidateSchemaCache,
  transformZodErrors,
  applyFormulaFields,
  validateEntityRefs,
  validateUserRefs,
} from "./validation/index.js";
import {
  resolveLookupFields,
  resolveLookupFieldsBatch,
} from "./lookup-resolver.js";
import { fireEntityAuditHook } from "./audit-hook.js";
import type { AuditFieldSensitivity } from "./audit-hook.js";

type EntityValidator = (
  fields: Record<string, unknown>,
  mode: "create" | "update",
) => FieldError[];

const crossFieldValidators = new Map<string, EntityValidator[]>();

export function registerValidator(
  entityTypeName: string,
  validator: EntityValidator,
): void {
  const existing = crossFieldValidators.get(entityTypeName) ?? [];
  crossFieldValidators.set(entityTypeName, [...existing, validator]);
}

export async function createEntity(
  db: DbOrTx,
  tenantId: string,
  input: CreateEntityInput,
): Promise<EntityInstance> {
  const entityType = await loadEntityType(db, input.entityTypeId);

  const schema = await getValidationSchema(
    db,
    input.entityTypeId,
    tenantId,
    "create",
  );
  const result = schema.safeParse(input.fields);

  if (!result.success) {
    throw new ValidationError(transformZodErrors(result.error));
  }

  const crossErrors = runCrossFieldValidators(
    entityType.name,
    result.data as Record<string, unknown>,
    "create",
  );
  if (crossErrors.length > 0) throw new ValidationError(crossErrors);

  const allFields = await loadEntityFields(db, input.entityTypeId, tenantId);

  // Cross-tenant reference guards: entity_ref and user_ref values must resolve
  // to resources owned by this tenant.  Runs after Zod (values are valid UUIDs)
  // but before INSERT.
  const [refErrors, userRefErrors] = await Promise.all([
    validateEntityRefs(
      db,
      tenantId,
      result.data as Record<string, unknown>,
      allFields,
    ),
    validateUserRefs(
      db,
      tenantId,
      result.data as Record<string, unknown>,
      allFields,
    ),
  ]);
  const allRefErrors = [...refErrors, ...userRefErrors];
  if (allRefErrors.length > 0) throw new ValidationError(allRefErrors);

  const fieldsWithFormulas = await applyFormulaFields(
    allFields,
    result.data as Record<string, unknown>,
  );

  let currentState = input.currentState;
  if (input.workflowId) {
    const states = await db
      .select({ name: workflowStates.name })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, input.workflowId));
    const validStates = states.map((s) => s.name);
    if (currentState) {
      if (!validStates.includes(currentState)) {
        throw new ValidationError([
          {
            field: "currentState",
            code: "invalid",
            message: `Invalid state '${currentState}' for the selected workflow. Valid states are: ${validStates.join(", ")}`,
          },
        ]);
      }
    } else {
      const resolved = await resolveInitialState(db, input.workflowId);
      // If the workflow's initialState is stale (state was deleted), fall back
      // to the first defined state rather than inserting an invalid value.
      currentState = validStates.includes(resolved)
        ? resolved
        : (validStates[0] ?? "initial");
    }
  } else {
    currentState = currentState ?? "initial";
  }

  const [row] = await db
    .insert(entityInstances)
    .values({
      entityTypeId: input.entityTypeId,
      tenantId,
      workflowId: input.workflowId ?? null,
      currentState,
      fields: fieldsWithFormulas,
      createdBy: input.createdBy ?? null,
      assignedTo: input.assignedTo ?? null,
    })
    .returning();

  if (!row) throw new EntityError("ENTITY_NOT_FOUND");

  if (row.workflowId) {
    await db.insert(workflowEvents).values({
      tenantId,
      instanceId: row.id,
      workflowId: row.workflowId,
      fromState: null,
      toState: row.currentState,
      triggeredBy: "user",
      actorId: input.actorId ?? input.createdBy ?? null,
      comment: "Record created",
      metadata: {
        type: "create",
        fields: fieldsWithFormulas,
        actorName: input.actorName ?? null,
      },
    });
  }

  logger.info(
    {
      tenantId,
      entityTypeId: input.entityTypeId,
      instanceId: row.id,
      actorId: input.createdBy,
    },
    "Entity created",
  );

  await fireEntityAuditHook({
    db,
    tenantId,
    actorId: input.createdBy ?? "system",
    actorType: input.createdBy !== undefined ? "user" : "system",
    resourceType: entityType.name,
    resourceId: row.id,
    action: "created",
    beforeSnapshot: null,
    afterSnapshot: row.fields as Record<string, unknown>,
    entityFields: allFields.map((f) => ({
      name: f.name,
      sensitivity: f.sensitivity,
    })),
  });

  return rowToInstance(row);
}

export async function getEntity(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<EntityInstance> {
  const [row] = await db
    .select()
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

  // Recompute computed fields on read: lookups first, then formulas
  // (formulas may reference lookup-resolved values)
  const allFields = await loadEntityFields(db, row.entityTypeId, tenantId);
  const fieldsWithLookups = await resolveLookupFields(
    db,
    tenantId,
    row.id,
    allFields,
    row.fields as Record<string, unknown>,
  );
  const fieldsWithFormulas = await applyFormulaFields(
    allFields,
    fieldsWithLookups,
  );

  const instanceWithFormulas = rowToInstance(row);
  instanceWithFormulas.fields = fieldsWithFormulas;
  return instanceWithFormulas;
}

export async function updateEntity(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  input: UpdateEntityInput,
): Promise<EntityInstance> {
  const [existing] = await db
    .select()
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!existing) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

  if (input.fields !== undefined) {
    // Step 1: validate only the provided fields (type/format checks)
    const partialSchema = await getValidationSchema(
      db,
      existing.entityTypeId,
      tenantId,
      "update",
    );
    const partialResult = partialSchema.safeParse(input.fields);
    if (!partialResult.success) {
      throw new ValidationError(transformZodErrors(partialResult.error));
    }

    // Step 2: merge and validate the full result (catches required-field clearing)
    const merged = {
      ...(existing.fields as Record<string, unknown>),
      ...(partialResult.data as Record<string, unknown>),
    };
    const fullSchema = await getValidationSchema(
      db,
      existing.entityTypeId,
      tenantId,
      "create",
    );
    const fullResult = fullSchema.safeParse(merged);
    if (!fullResult.success) {
      throw new ValidationError(transformZodErrors(fullResult.error));
    }

    const entityType = await loadEntityType(db, existing.entityTypeId);
    const crossErrors = runCrossFieldValidators(
      entityType.name,
      fullResult.data as Record<string, unknown>,
      "update",
    );
    if (crossErrors.length > 0) throw new ValidationError(crossErrors);

    const allFields = await loadEntityFields(
      db,
      existing.entityTypeId,
      tenantId,
    );

    // Cross-tenant reference guards (update path): validate only the fields
    // being changed — existing refs were validated on create / prior update.
    // input.fields is narrowed to Record<string,unknown> by the enclosing if.
    const providedFields = input.fields;
    const updatedEntityRefFields = allFields.filter(
      (f) => f.fieldType === "entity_ref" && f.name in providedFields,
    );
    const updatedUserRefFields = allFields.filter(
      (f) => f.fieldType === "user_ref" && f.name in providedFields,
    );
    if (updatedEntityRefFields.length > 0 || updatedUserRefFields.length > 0) {
      const [refErrors, userRefErrors] = await Promise.all([
        updatedEntityRefFields.length > 0
          ? validateEntityRefs(
              db,
              tenantId,
              providedFields,
              updatedEntityRefFields,
            )
          : Promise.resolve([]),
        updatedUserRefFields.length > 0
          ? validateUserRefs(db, tenantId, providedFields, updatedUserRefFields)
          : Promise.resolve([]),
      ]);
      const allRefErrors = [...refErrors, ...userRefErrors];
      if (allRefErrors.length > 0) throw new ValidationError(allRefErrors);
    }

    const fieldsWithFormulas = await applyFormulaFields(
      allFields,
      fullResult.data as Record<string, unknown>,
    );

    const updates: Partial<typeof entityInstances.$inferInsert> = {
      fields: fieldsWithFormulas,
      updatedAt: new Date(),
    };
    if (input.assignedTo !== undefined) {
      updates.assignedTo = input.assignedTo;
    }
    if (input.currentState !== undefined && input.currentState !== null) {
      if (existing.workflowId) {
        const states = await db
          .select({ name: workflowStates.name })
          .from(workflowStates)
          .where(eq(workflowStates.workflowId, existing.workflowId));
        const validStates = states.map((s) => s.name);
        if (!validStates.includes(input.currentState)) {
          throw new ValidationError([
            {
              field: "currentState",
              code: "invalid",
              message: `Invalid state '${input.currentState}' for the workflow. Valid states are: ${validStates.join(", ")}`,
            },
          ]);
        }
      }
      updates.currentState = input.currentState;
    }

    const [row] = await db
      .update(entityInstances)
      .set(updates)
      .where(
        and(
          eq(entityInstances.id, instanceId),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .returning();

    if (!row) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

    // Logging logic
    if (row.workflowId) {
      const oldFields = existing.fields as Record<string, unknown>;
      const newFields = row.fields as Record<string, unknown>;
      const changed: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(newFields)) {
        if (JSON.stringify(oldFields[key]) !== JSON.stringify(newFields[key])) {
          changed[key] = { old: oldFields[key], new: newFields[key] };
        }
      }
      if (existing.assignedTo !== row.assignedTo) {
        changed["assignedTo"] = {
          old: existing.assignedTo,
          new: row.assignedTo,
        };
      }
      if (existing.currentState !== row.currentState) {
        changed["state"] = {
          old: existing.currentState,
          new: row.currentState,
        };
      }

      if (
        Object.keys(changed).length > 0 ||
        existing.currentState !== row.currentState
      ) {
        await db.insert(workflowEvents).values({
          tenantId,
          instanceId,
          workflowId: row.workflowId,
          fromState: existing.currentState,
          toState: row.currentState,
          triggeredBy: "user",
          actorId: input.actorId ?? null,
          comment:
            existing.currentState !== row.currentState
              ? `State changed to ${row.currentState}`
              : "Record updated",
          metadata: {
            type: "update",
            changed,
            actorName: input.actorName ?? null,
          },
        });
      }
    }

    logger.info({ tenantId, instanceId }, "Entity updated");

    await fireEntityAuditHook({
      db,
      tenantId,
      actorId: input.actorId ?? "system",
      actorType:
        input.actorType ?? (input.actorId !== undefined ? "user" : "system"),
      resourceType: entityType.name,
      resourceId: instanceId,
      action: "updated",
      beforeSnapshot: existing.fields as Record<string, unknown>,
      afterSnapshot: row.fields as Record<string, unknown>,
      entityFields: allFields.map((f) => ({
        name: f.name,
        sensitivity: f.sensitivity,
      })),
    });

    return rowToInstance(row);
  }

  // Fields not provided — updating assignedTo and/or currentState
  if (input.assignedTo !== undefined || input.currentState !== undefined) {
    const updates: Partial<typeof entityInstances.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.assignedTo !== undefined) {
      updates.assignedTo = input.assignedTo;
    }
    if (input.currentState !== undefined && input.currentState !== null) {
      if (existing.workflowId) {
        const states = await db
          .select({ name: workflowStates.name })
          .from(workflowStates)
          .where(eq(workflowStates.workflowId, existing.workflowId));
        const validStates = states.map((s) => s.name);
        if (!validStates.includes(input.currentState)) {
          throw new ValidationError([
            {
              field: "currentState",
              code: "invalid",
              message: `Invalid state '${input.currentState}' for the workflow. Valid states are: ${validStates.join(", ")}`,
            },
          ]);
        }
      }
      updates.currentState = input.currentState;
    }

    const [row] = await db
      .update(entityInstances)
      .set(updates)
      .where(
        and(
          eq(entityInstances.id, instanceId),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .returning();

    if (!row) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

    // Logging logic for assignedTo and/or currentState update
    if (row.workflowId) {
      const changed: Record<string, { old: unknown; new: unknown }> = {};
      if (existing.assignedTo !== row.assignedTo) {
        changed["assignedTo"] = {
          old: existing.assignedTo,
          new: row.assignedTo,
        };
      }
      if (existing.currentState !== row.currentState) {
        changed["state"] = {
          old: existing.currentState,
          new: row.currentState,
        };
      }

      if (
        existing.currentState !== row.currentState ||
        Object.keys(changed).length > 0
      ) {
        await db.insert(workflowEvents).values({
          tenantId,
          instanceId,
          workflowId: row.workflowId,
          fromState: existing.currentState,
          toState: row.currentState,
          triggeredBy: "user",
          actorId: input.actorId ?? null,
          comment:
            existing.currentState !== row.currentState
              ? `State changed to ${row.currentState}`
              : "Record updated",
          metadata: {
            type: "update",
            changed,
            actorName: input.actorName ?? null,
          },
        });
      }
    }

    return rowToInstance(row);
  }

  return rowToInstance(existing);
}

export async function deleteEntity(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  actorId?: string,
): Promise<void> {
  // Single UPDATE...RETURNING: soft-deletes the row and captures the pre-deletion
  // fields snapshot for the audit log in one round trip. The isNull guard ensures
  // idempotency — a second delete attempt returns no rows → ENTITY_NOT_FOUND.
  const [row] = await db
    .update(entityInstances)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .returning();

  if (!row) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

  logger.info({ tenantId, instanceId }, "Entity soft-deleted");

  const [entityType, allFields] = await Promise.all([
    loadEntityType(db, row.entityTypeId),
    loadEntityFields(db, row.entityTypeId, tenantId),
  ]);

  await fireEntityAuditHook({
    db,
    tenantId,
    actorId: actorId ?? "system",
    actorType: actorId !== undefined ? "user" : "system",
    resourceType: entityType.name,
    resourceId: instanceId,
    action: "deleted",
    beforeSnapshot: row.fields as Record<string, unknown>,
    afterSnapshot: null,
    entityFields: allFields.map((f) => ({
      name: f.name,
      sensitivity: f.sensitivity,
    })),
  });
}

export async function listEntities(
  db: DbOrTx,
  tenantId: string,
  input: ListEntitiesInput,
): Promise<CursorPage<EntityInstance>> {
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const conditions = [
    eq(entityInstances.tenantId, tenantId),
    eq(entityInstances.entityTypeId, input.entityTypeId),
  ];

  if (!input.includeDeleted) {
    conditions.push(isNull(entityInstances.deletedAt));
  }
  if (input.state !== undefined) {
    conditions.push(eq(entityInstances.currentState, input.state));
  }
  if (input.assignedTo !== undefined) {
    conditions.push(eq(entityInstances.assignedTo, input.assignedTo));
  }
  if (
    input.fieldFilters !== undefined &&
    Object.keys(input.fieldFilters).length > 0
  ) {
    conditions.push(
      sql`${entityInstances.fields} @> ${JSON.stringify(input.fieldFilters)}::jsonb`,
    );
  }
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      const cursorCond = or(
        gt(entityInstances.createdAt, decoded.createdAt),
        and(
          eq(entityInstances.createdAt, decoded.createdAt),
          gt(entityInstances.id, decoded.id),
        ),
      );
      if (cursorCond) conditions.push(cursorCond);
    }
  }

  const rows = await db
    .select()
    .from(entityInstances)
    .where(and(...conditions))
    .orderBy(asc(entityInstances.createdAt), asc(entityInstances.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  // Batch-resolve lookup fields (two queries per relationType, no N+1),
  // then apply formula fields with lookup values already present.
  const allFields = await loadEntityFields(db, input.entityTypeId, tenantId);
  const instances = data.map((r) => ({
    id: r.id,
    fields: r.fields as Record<string, unknown>,
  }));
  const resolvedMap = await resolveLookupFieldsBatch(
    db,
    tenantId,
    instances,
    allFields,
  );

  const resolvedData = await Promise.all(
    data.map(async (row) => {
      const withLookups =
        resolvedMap.get(row.id) ?? (row.fields as Record<string, unknown>);
      const withFormulas = await applyFormulaFields(allFields, withLookups);
      const instance = rowToInstance(row);
      instance.fields = withFormulas;
      return instance;
    }),
  );

  return { data: resolvedData, nextCursor };
}

export async function addEntityField(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
  field: Omit<EntityField, "id" | "tenantId">,
): Promise<EntityField> {
  const entityType = await loadEntityType(db, entityTypeId);

  if (!entityType.allowCustomFields && entityType.tenantId !== null) {
    throw new EntityError("CUSTOM_FIELDS_NOT_ALLOWED", { entityTypeId });
  }

  const [row] = await db
    .insert(entityFields)
    .values({
      entityTypeId,
      tenantId,
      name: field.name,
      label: field.label,
      fieldType: field.fieldType,
      config: field.config,
      isRequired: field.isRequired,
      isIndexed: field.isIndexed,
      isSystem: field.isSystem,
      sortOrder: field.sortOrder,
    })
    .returning();

  if (!row) throw new EntityError("ENTITY_TYPE_NOT_FOUND");

  await invalidateSchemaCache(entityTypeId, tenantId);

  return {
    ...row,
    config: row.config as Record<string, unknown>,
    fieldType: row.fieldType as EntityField["fieldType"],
    sensitivity: row.sensitivity as EntityField["sensitivity"],
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function loadEntityType(
  db: DbOrTx,
  entityTypeId: string,
): Promise<EntityType> {
  const [row] = await db
    .select()
    .from(entityTypes)
    .where(eq(entityTypes.id, entityTypeId))
    .limit(1);

  if (!row) throw new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId });

  return {
    ...row,
    tenantId: row.tenantId ?? null,
    moduleId: row.moduleId ?? null,
    icon: row.icon ?? null,
    allowCustomFields: row.allowCustomFields,
  };
}

async function loadEntityFields(
  db: DbOrTx,
  entityTypeId: string,
  tenantId: string,
): Promise<EntityField[]> {
  const rows = await db
    .select()
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityTypeId),
        or(isNull(entityFields.tenantId), eq(entityFields.tenantId, tenantId)),
      ),
    )
    .orderBy(entityFields.sortOrder);

  return rows.map((r) => ({
    ...r,
    config: r.config as Record<string, unknown>,
    fieldType: r.fieldType as EntityField["fieldType"],
    sensitivity: r.sensitivity as EntityField["sensitivity"],
  }));
}

async function resolveInitialState(
  db: DbOrTx,
  workflowId: string | undefined | null,
): Promise<string> {
  if (!workflowId) return "initial";
  const [wf] = await db
    .select({ initialState: workflows.initialState })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);
  return wf?.initialState ?? "initial";
}

function runCrossFieldValidators(
  entityTypeName: string,
  fields: Record<string, unknown>,
  mode: "create" | "update",
): FieldError[] {
  const validators = crossFieldValidators.get(entityTypeName) ?? [];
  return validators.flatMap((v) => v(fields, mode));
}

function rowToInstance(
  row: typeof entityInstances.$inferSelect,
): EntityInstance {
  return {
    id: row.id,
    entityTypeId: row.entityTypeId,
    tenantId: row.tenantId,
    workflowId: row.workflowId ?? null,
    currentState: row.currentState,
    fields: row.fields as Record<string, unknown>,
    createdBy: row.createdBy ?? null,
    assignedTo: row.assignedTo ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

// ── Bulk operations ───────────────────────────────────────────────────────────

export async function bulkCreateEntities(
  db: DbOrTx,
  tenantId: string,
  inputs: CreateEntityInput[],
): Promise<BulkCreateResult> {
  const errors: BulkCreateResult["errors"] = [];
  const toInsert: Array<typeof entityInstances.$inferInsert> = [];
  // Parallel array to toInsert — captures audit context for each valid item
  const auditMeta: Array<{
    entityTypeName: string;
    createdBy: string | null;
    entityFields: Array<{ name: string; sensitivity: AuditFieldSensitivity }>;
  }> = [];

  // Per-type cache: avoids O(N) DB calls for entityType + allFields when many
  // rows share the same type. Schema validation happens first (it already has
  // its own Redis cache), so this cache is only populated for types that have
  // at least one valid item — avoiding wasteful loads on items that fail validation.
  type TypeMeta = {
    entityType: Awaited<ReturnType<typeof loadEntityType>>;
    allFields: Awaited<ReturnType<typeof loadEntityFields>>;
  };
  const typeMetaCache = new Map<string, TypeMeta>();

  async function getTypeMeta(entityTypeId: string): Promise<TypeMeta> {
    const cached = typeMetaCache.get(entityTypeId);
    if (cached) return cached;
    const [entityType, allFields] = await Promise.all([
      loadEntityType(db, entityTypeId),
      loadEntityFields(db, entityTypeId, tenantId),
    ]);
    const meta: TypeMeta = { entityType, allFields };
    typeMetaCache.set(entityTypeId, meta);
    return meta;
  }

  for (const [i, input] of inputs.entries()) {
    const schema = await getValidationSchema(
      db,
      input.entityTypeId,
      tenantId,
      "create",
    );
    const result = schema.safeParse(input.fields);

    if (!result.success) {
      errors.push({ index: i, fields: transformZodErrors(result.error) });
      continue;
    }

    const { entityType, allFields } = await getTypeMeta(input.entityTypeId);
    const crossErrors = runCrossFieldValidators(
      entityType.name,
      result.data as Record<string, unknown>,
      "create",
    );
    if (crossErrors.length > 0) {
      errors.push({ index: i, fields: crossErrors });
      continue;
    }
    const fieldsWithFormulas = await applyFormulaFields(
      allFields,
      result.data as Record<string, unknown>,
    );

    const [refErrors, userRefErrors] = await Promise.all([
      validateEntityRefs(
        db,
        tenantId,
        result.data as Record<string, unknown>,
        allFields,
      ),
      validateUserRefs(
        db,
        tenantId,
        result.data as Record<string, unknown>,
        allFields,
      ),
    ]);
    const allRefErrors = [...refErrors, ...userRefErrors];
    if (allRefErrors.length > 0) {
      errors.push({ index: i, fields: allRefErrors });
      continue;
    }

    const initialState = await resolveInitialState(db, input.workflowId);

    toInsert.push({
      entityTypeId: input.entityTypeId,
      tenantId,
      workflowId: input.workflowId ?? null,
      currentState: initialState,
      fields: fieldsWithFormulas,
      createdBy: input.createdBy ?? null,
      assignedTo: input.assignedTo ?? null,
    });

    // Save audit context for this item (parallel to toInsert)
    auditMeta.push({
      entityTypeName: entityType.name,
      createdBy: input.createdBy ?? null,
      entityFields: allFields.map((f) => ({
        name: f.name,
        sensitivity: f.sensitivity,
      })),
    });
  }

  if (toInsert.length === 0) {
    return { created: [], errors };
  }

  const rows = await db.insert(entityInstances).values(toInsert).returning();

  const created = rows.map(rowToInstance);

  // Fire audit hooks for each created entity
  for (const [idx, row] of rows.entries()) {
    const meta = auditMeta[idx];
    if (!meta) continue;
    await fireEntityAuditHook({
      db,
      tenantId,
      actorId: meta.createdBy ?? "system",
      actorType: meta.createdBy !== null ? "user" : "system",
      resourceType: meta.entityTypeName,
      resourceId: row.id,
      action: "created",
      beforeSnapshot: null,
      afterSnapshot: row.fields as Record<string, unknown>,
      entityFields: meta.entityFields,
    });
  }

  logger.info(
    { tenantId, count: created.length, errorCount: errors.length },
    "Bulk create completed",
  );

  return { created, errors };
}

export async function bulkUpdateEntities(
  db: DbOrTx,
  tenantId: string,
  updates: Array<{ id: string; input: UpdateEntityInput }>,
): Promise<BulkUpdateResult> {
  const updated: EntityInstance[] = [];
  const errors: BulkUpdateResult["errors"] = [];

  await Promise.all(
    updates.map(async ({ id, input }, i) => {
      const [existing] = await db
        .select()
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, id),
            eq(entityInstances.tenantId, tenantId),
            isNull(entityInstances.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) {
        errors.push({ index: i, id, code: "ENTITY_NOT_FOUND" });
        return;
      }

      if (input.fields !== undefined) {
        const partialSchema = await getValidationSchema(
          db,
          existing.entityTypeId,
          tenantId,
          "update",
        );
        const partialResult = partialSchema.safeParse(input.fields);
        if (!partialResult.success) {
          errors.push({
            index: i,
            id,
            code: "VALIDATION_ERROR",
            fields: transformZodErrors(partialResult.error),
          });
          return;
        }

        const merged = {
          ...(existing.fields as Record<string, unknown>),
          ...(partialResult.data as Record<string, unknown>),
        };
        const fullSchema = await getValidationSchema(
          db,
          existing.entityTypeId,
          tenantId,
          "create",
        );
        const fullResult = fullSchema.safeParse(merged);
        if (!fullResult.success) {
          errors.push({
            index: i,
            id,
            code: "VALIDATION_ERROR",
            fields: transformZodErrors(fullResult.error),
          });
          return;
        }

        const entityType = await loadEntityType(db, existing.entityTypeId);
        const crossErrors = runCrossFieldValidators(
          entityType.name,
          fullResult.data as Record<string, unknown>,
          "update",
        );
        if (crossErrors.length > 0) {
          errors.push({
            index: i,
            id,
            code: "VALIDATION_ERROR",
            fields: crossErrors,
          });
          return;
        }

        const allFields = await loadEntityFields(
          db,
          existing.entityTypeId,
          tenantId,
        );
        const fieldsWithFormulas = await applyFormulaFields(
          allFields,
          fullResult.data as Record<string, unknown>,
        );

        const updateValues: Partial<typeof entityInstances.$inferInsert> = {
          fields: fieldsWithFormulas,
          updatedAt: new Date(),
        };
        if (input.assignedTo !== undefined) {
          updateValues.assignedTo = input.assignedTo;
        }

        const [row] = await db
          .update(entityInstances)
          .set(updateValues)
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .returning();

        if (row) {
          updated.push(rowToInstance(row));
          await fireEntityAuditHook({
            db,
            tenantId,
            actorId: input.actorId ?? "system",
            actorType:
              input.actorType ??
              (input.actorId !== undefined ? "user" : "system"),
            resourceType: entityType.name,
            resourceId: id,
            action: "updated",
            beforeSnapshot: existing.fields as Record<string, unknown>,
            afterSnapshot: row.fields as Record<string, unknown>,
            entityFields: allFields.map((f) => ({
              name: f.name,
              sensitivity: f.sensitivity,
            })),
          });
        }
      } else if (input.assignedTo !== undefined) {
        const [row] = await db
          .update(entityInstances)
          .set({ assignedTo: input.assignedTo, updatedAt: new Date() })
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .returning();

        if (row) {
          updated.push(rowToInstance(row));
          // Load entity type for audit — not needed for the fields update path
          // above (entityType is already available there) but needed here.
          const [bulkEntityType, bulkAllFields] = await Promise.all([
            loadEntityType(db, existing.entityTypeId),
            loadEntityFields(db, existing.entityTypeId, tenantId),
          ]);
          await fireEntityAuditHook({
            db,
            tenantId,
            actorId: input.actorId ?? "system",
            actorType:
              input.actorType ??
              (input.actorId !== undefined ? "user" : "system"),
            resourceType: bulkEntityType.name,
            resourceId: id,
            action: "updated",
            beforeSnapshot: existing.fields as Record<string, unknown>,
            afterSnapshot: row.fields as Record<string, unknown>,
            entityFields: bulkAllFields.map((f) => ({
              name: f.name,
              sensitivity: f.sensitivity,
            })),
          });
        }
      } else {
        updated.push(rowToInstance(existing));
      }
    }),
  );

  logger.info(
    { tenantId, count: updated.length, errorCount: errors.length },
    "Bulk update completed",
  );

  return { updated, errors };
}

export async function bulkSetState(
  db: DbOrTx,
  tenantId: string,
  items: Array<{ id: string; state: string }>,
): Promise<BulkSetStateResult> {
  if (items.length === 0) return { updatedIds: [], errors: [] };

  const ids = items.map((item) => item.id);

  // Load all matching instances in one query to verify tenant ownership.
  // Also fetch entityTypeId and currentState for audit hooks.
  const existing = await db
    .select({
      id: entityInstances.id,
      entityTypeId: entityInstances.entityTypeId,
      currentState: entityInstances.currentState,
    })
    .from(entityInstances)
    .where(
      and(
        inArray(entityInstances.id, ids),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    );

  const foundMap = new Map(existing.map((r) => [r.id, r]));
  const foundIds = new Set(existing.map((r) => r.id));

  const errors: BulkSetStateResult["errors"] = [];
  const validItems: Array<{ id: string; state: string }> = [];

  for (const [i, item] of items.entries()) {
    if (!foundIds.has(item.id)) {
      errors.push({ index: i, id: item.id, code: "ENTITY_NOT_FOUND" });
    } else {
      validItems.push(item);
    }
  }

  if (validItems.length === 0) return { updatedIds: [], errors };

  // Group by target state — one UPDATE per unique state value
  const byState = new Map<string, string[]>();
  for (const item of validItems) {
    const bucket = byState.get(item.state) ?? [];
    bucket.push(item.id);
    byState.set(item.state, bucket);
  }

  const updatedIds: string[] = [];

  for (const [state, stateIds] of byState) {
    const rows = await db
      .update(entityInstances)
      .set({ currentState: state, updatedAt: new Date() })
      .where(
        and(
          inArray(entityInstances.id, stateIds),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .returning({ id: entityInstances.id });

    updatedIds.push(...rows.map((r) => r.id));
  }

  // Fire audit hooks for each successfully transitioned entity.
  // Cache entity type metadata by entityTypeId to avoid N+1 queries.
  const typeCache = new Map<
    string,
    {
      name: string;
      fields: Array<{ name: string; sensitivity: AuditFieldSensitivity }>;
    }
  >();

  for (const item of validItems) {
    const prior = foundMap.get(item.id);
    if (!prior) continue;

    if (!typeCache.has(prior.entityTypeId)) {
      const [et, ef] = await Promise.all([
        loadEntityType(db, prior.entityTypeId),
        loadEntityFields(db, prior.entityTypeId, tenantId),
      ]);
      typeCache.set(prior.entityTypeId, {
        name: et.name,
        fields: ef.map((f) => ({ name: f.name, sensitivity: f.sensitivity })),
      });
    }

    const cached = typeCache.get(prior.entityTypeId);
    if (!cached) continue;

    await fireEntityAuditHook({
      db,
      tenantId,
      actorId: "system",
      actorType: "system",
      resourceType: cached.name,
      resourceId: item.id,
      action: "transitioned",
      beforeSnapshot: { currentState: prior.currentState },
      afterSnapshot: { currentState: item.state },
      entityFields: cached.fields,
    });
  }

  logger.info(
    { tenantId, count: updatedIds.length, errorCount: errors.length },
    "Bulk state-set completed",
  );

  return { updatedIds, errors };
}

export async function setEntityState(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  state: string,
): Promise<EntityInstance> {
  const [existing] = await db
    .select({
      id: entityInstances.id,
      entityTypeId: entityInstances.entityTypeId,
      currentState: entityInstances.currentState,
    })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!existing) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

  const [row] = await db
    .update(entityInstances)
    .set({ currentState: state, updatedAt: new Date() })
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .returning();

  if (!row) throw new EntityError("ENTITY_NOT_FOUND", { instanceId });

  logger.info({ tenantId, instanceId, state }, "Entity state set");

  const [entityType, allFields] = await Promise.all([
    loadEntityType(db, existing.entityTypeId),
    loadEntityFields(db, existing.entityTypeId, tenantId),
  ]);

  await fireEntityAuditHook({
    db,
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: entityType.name,
    resourceId: instanceId,
    action: "transitioned",
    beforeSnapshot: { currentState: existing.currentState },
    afterSnapshot: { currentState: state },
    entityFields: allFields.map((f) => ({
      name: f.name,
      sensitivity: f.sensitivity,
    })),
  });

  return rowToInstance(row);
}
