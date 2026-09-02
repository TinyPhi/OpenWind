import {
  eq,
  and,
  asc,
  gt,
  isNull,
  or,
  inArray,
  sql,
  notExists,
} from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityInstances,
  entityTypes,
  entityFields,
  workflows,
  workflowStates,
  workflowEvents,
  entityRelations,
  outboxEvents,
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
  EntityCreatedEvent,
  EntityAssignedEvent,
  EntityUnassignedEvent,
  EntityDueDateScheduledEvent,
  FieldSensitivity,
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
import { getParentId } from "./child-relations.js";
import { redactFields, buildSensitivityMap } from "./redact.js";

type EntityValidator = (
  fields: Record<string, unknown>,
  mode: "create" | "update",
) => FieldError[];

const crossFieldValidators = new Map<string, EntityValidator[]>();

// Child tickets inherit their parent's workflowId, so they're validated against this
// fixed set rather than the parent's full workflow_states (#185).
const CHILD_TICKET_STATES: readonly string[] = [
  "open",
  "in-progress",
  "closed",
];

/** @internal exported for child-relations.ts — not part of the package's public API */
export function buildEntityCreatedPayload(
  tenantId: string,
  instanceId: string,
  entityTypeId: string,
  fields: Record<string, unknown>,
  createdBy: string | null,
  depth?: number,
): EntityCreatedEvent {
  return {
    eventType: "entity.created",
    version: 1,
    tenantId,
    instanceId,
    entityTypeId,
    fields,
    createdBy,
    // depth + 1 for the guard, mirroring buildEntityAssignedPayload's
    // convention — only set when this creation was itself driven by an
    // automation rule (#120/#218).
    ...(depth !== undefined && { depth: depth + 1 }),
  };
}

export function buildEntityAssignedPayload(
  tenantId: string,
  instanceId: string,
  entityTypeId: string,
  assigneeId: string,
  assignedBy: string | null,
  depth?: number,
): EntityAssignedEvent {
  return {
    eventType: "entity.assigned",
    version: 1,
    tenantId,
    instanceId,
    entityTypeId,
    assigneeId,
    assignedBy,
    // depth + 1 for the guard, mirroring the transition action's convention
    // (packages/automation-engine/src/actions/transition.ts) — only set when
    // this assignment was itself driven by an automation rule (#120).
    ...(depth !== undefined && { depth: depth + 1 }),
  };
}

export function buildEntityUnassignedPayload(
  tenantId: string,
  instanceId: string,
  entityTypeId: string,
  previousAssigneeId: string,
  actorId: string | null,
  depth?: number,
): EntityUnassignedEvent {
  return {
    eventType: "entity.unassigned",
    version: 1,
    tenantId,
    instanceId,
    entityTypeId,
    previousAssigneeId,
    actorId,
    ...(depth !== undefined && { depth: depth + 1 }),
  };
}

export function buildEntityDueDateScheduledPayload(
  tenantId: string,
  instanceId: string,
  entityTypeId: string,
  dueDate: Date,
): EntityDueDateScheduledEvent {
  return {
    eventType: "entity.due_date_scheduled",
    version: 1,
    tenantId,
    instanceId,
    entityTypeId,
    dueDate: dueDate.toISOString(),
  };
}

// Reschedule/cancel semantics for due_date (docs/specs/due-date.md R5): any
// change to due_date — including clearing it — supersedes a still-pending
// `entity.due_date_scheduled` outbox row before a fresh one (if any) is
// written, so due-date-scheduler.ts never enqueues a stale fire time. Callers
// must run this inside the same transaction as the entity_instances write
// that changed due_date, mirroring the assignedTo outbox pattern above.
async function rescheduleDueDate(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  entityTypeId: string,
  oldDueDate: Date | null,
  newDueDate: Date | null,
): Promise<void> {
  const oldTime = oldDueDate?.getTime() ?? null;
  const newTime = newDueDate?.getTime() ?? null;
  if (oldTime === newTime) return;

  await db.execute(sql`
    UPDATE outbox_events
    SET delivered_at = now()
    WHERE delivered_at IS NULL
      AND event_type = 'entity.due_date_scheduled'
      AND tenant_id = ${tenantId}
      AND payload ->> 'instanceId' = ${instanceId}
  `);

  if (newDueDate !== null) {
    await db.insert(outboxEvents).values({
      tenantId,
      eventType: "entity.due_date_scheduled",
      version: 1,
      payload: buildEntityDueDateScheduledPayload(
        tenantId,
        instanceId,
        entityTypeId,
        newDueDate,
      ),
    });
  }
}

// Consistent "who assigned this" fallback for entity.assigned events: prefer
// the explicit actor, then the record's creator, before giving up on null.
// Previously computed ad hoc and inconsistently at each of the 6 call sites
// (createEntity/updateEntity x2/bulkCreateEntities/bulkUpdateEntities x2) —
// found during review, one call site dropped actorId entirely.
export function resolveAssignedBy(
  actorId: string | undefined,
  createdBy: string | null,
): string | null {
  return actorId ?? createdBy ?? null;
}

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
  const entityType = await loadEntityType(db, input.entityTypeId, tenantId);

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
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
    })
    .returning();

  if (!row) throw new EntityError("ENTITY_NOT_FOUND");

  if (row.dueDate !== null) {
    await rescheduleDueDate(
      db,
      tenantId,
      row.id,
      row.entityTypeId,
      null,
      row.dueDate,
    );
  }

  // Field values are redacted before leaving the entity engine's field-level
  // access boundary — both workflow_events.metadata (agent-facing audit trail)
  // and outbox_events (feeds automation actions, e.g. webhook, that can
  // forward the payload to external URLs) get the same "[REDACTED]"
  // treatment admin_audit_log already applies, via redactFields/buildSensitivityMap.
  const creationSensitivity = buildSensitivityMap(allFields);
  const redactedFieldsForEvents = redactFields(
    fieldsWithFormulas,
    creationSensitivity,
  );

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
        fields: redactedFieldsForEvents,
        actorName: input.actorName ?? null,
      },
    });
  }

  // Outbox events for automation triggers (#126). depth is threaded through
  // (#218) so a self-triggering create_entity automation rule trips
  // MAX_DEPTH on the outbox hop instead of silently resuming at depth 0.
  const outboxRows: Array<EntityCreatedEvent | EntityAssignedEvent> = [
    buildEntityCreatedPayload(
      tenantId,
      row.id,
      row.entityTypeId,
      redactedFieldsForEvents,
      row.createdBy,
      input.depth,
    ),
  ];
  if (row.assignedTo !== null) {
    outboxRows.push(
      buildEntityAssignedPayload(
        tenantId,
        row.id,
        row.entityTypeId,
        row.assignedTo,
        resolveAssignedBy(input.actorId, row.createdBy),
        input.depth,
      ),
    );
  }
  await db.insert(outboxEvents).values(
    outboxRows.map((payload) => ({
      tenantId,
      eventType: payload.eventType,
      version: 1,
      payload,
    })),
  );

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
    actorId: input.actorId ?? input.createdBy ?? "system",
    actorType:
      input.actorType ?? (input.createdBy !== undefined ? "user" : "system"),
    actingPersonId: input.actingPersonId,
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

    // Step 2: merge and validate the full result (catches required-field clearing).
    // Skip for child tickets — they are intentionally created with minimal fields
    // and do not satisfy the parent entity type's required fields. Determined
    // from the actual entity_relations table, not a heuristic on field content
    // (a `child_status` field on an unrelated entity type must not silently
    // skip validation just because it happens to share that field name).
    const isChildTicket =
      (await getParentId(db, tenantId, instanceId)) !== null;
    const merged = {
      ...(existing.fields as Record<string, unknown>),
      ...(partialResult.data as Record<string, unknown>),
    };
    // validatedFields feeds formula computation and downstream processing.
    // For non-child tickets this is the zod-parsed/coerced fullResult.data —
    // using the raw `merged` here was a regression that silently fed
    // pre-coercion values into applyFormulaFields for every entity type, not
    // just child tickets. Child tickets have no "full" schema to validate
    // against (see above), so merged is the only value available for them.
    let validatedFields: Record<string, unknown> = merged;
    if (!isChildTicket) {
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
      validatedFields = fullResult.data as Record<string, unknown>;
    }

    const entityType = await loadEntityType(
      db,
      existing.entityTypeId,
      tenantId,
    );
    if (!isChildTicket) {
      const crossErrors = runCrossFieldValidators(
        entityType.name,
        validatedFields,
        "update",
      );
      if (crossErrors.length > 0) throw new ValidationError(crossErrors);
    }

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
      validatedFields,
    );

    const updates: Partial<typeof entityInstances.$inferInsert> = {
      fields: fieldsWithFormulas,
      updatedAt: new Date(),
    };
    if (input.assignedTo !== undefined) {
      updates.assignedTo = input.assignedTo;
    }
    if (input.dueDate !== undefined) {
      updates.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    }
    if (input.currentState !== undefined && input.currentState !== null) {
      if (isChildTicket) {
        if (!CHILD_TICKET_STATES.includes(input.currentState)) {
          throw new ValidationError([
            {
              field: "currentState",
              code: "invalid",
              message: `Child ticket state must be one of: ${CHILD_TICKET_STATES.join(", ")}`,
            },
          ]);
        }
      } else if (existing.workflowId) {
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

    if (row.assignedTo !== null && row.assignedTo !== existing.assignedTo) {
      await db.insert(outboxEvents).values({
        tenantId,
        eventType: "entity.assigned",
        version: 1,
        payload: buildEntityAssignedPayload(
          tenantId,
          row.id,
          row.entityTypeId,
          row.assignedTo,
          resolveAssignedBy(input.actorId, row.createdBy),
          input.depth,
        ),
      });
    }

    // Notifies the user who LOST the assignment, distinct from the above
    // entity.assigned (which only ever notifies the new assignee) —
    // requires a real previous assignee, so this never fires on a
    // first-time assignment (existing.assignedTo === null).
    if (
      existing.assignedTo !== null &&
      row.assignedTo !== existing.assignedTo
    ) {
      await db.insert(outboxEvents).values({
        tenantId,
        eventType: "entity.unassigned",
        version: 1,
        payload: buildEntityUnassignedPayload(
          tenantId,
          row.id,
          row.entityTypeId,
          existing.assignedTo,
          input.actorId ?? null,
          input.depth,
        ),
      });
    }

    if (input.dueDate !== undefined) {
      await rescheduleDueDate(
        db,
        tenantId,
        row.id,
        row.entityTypeId,
        existing.dueDate,
        row.dueDate,
      );
    }

    // Logging logic — for child tickets with null workflowId (legacy data before
    // inheritance fix), fall back to the parent's workflowId via the relation.
    let effectiveWorkflowId = row.workflowId;
    if (!effectiveWorkflowId) {
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
        effectiveWorkflowId = parent?.workflowId ?? null;
      }
    }
    if (effectiveWorkflowId) {
      // Diff on raw values (redacting first would make every pii/financial
      // change look like a no-op, since both sides would collapse to the
      // same "[REDACTED]" string) — redact only the values actually stored.
      const updateSensitivity = buildSensitivityMap(allFields);
      const oldFields = existing.fields as Record<string, unknown>;
      const newFields = row.fields as Record<string, unknown>;
      const changed: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(newFields)) {
        if (JSON.stringify(oldFields[key]) !== JSON.stringify(newFields[key])) {
          const sensitivity = updateSensitivity.get(key);
          const isSensitive =
            sensitivity === "pii" || sensitivity === "financial";
          changed[key] = {
            old: isSensitive ? "[REDACTED]" : oldFields[key],
            new: isSensitive ? "[REDACTED]" : newFields[key],
          };
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
          workflowId: effectiveWorkflowId,
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

      // ui-feature-checklist-and-rules.md §2.5 — a genuine custom-field edit
      // notifies creator + assignedTo. Deliberately excludes the case where
      // `changed` contains ONLY the synthetic "assignedTo"/"state" pseudo-keys
      // above — those are entity.assigned's and workflow.transitioned's jobs
      // respectively (§2.4), and firing both here too would double-notify.
      const realFieldKeys = Object.keys(changed).filter(
        (k) => k !== "assignedTo" && k !== "state",
      );
      if (realFieldKeys.length > 0) {
        await db.insert(outboxEvents).values({
          tenantId,
          eventType: "entity.updated",
          version: 1,
          payload: {
            eventType: "entity.updated",
            version: 1,
            tenantId,
            instanceId,
            actorId: input.actorId ?? null,
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

  // Fields not provided — updating assignedTo and/or currentState and/or dueDate
  if (
    input.assignedTo !== undefined ||
    input.currentState !== undefined ||
    input.dueDate !== undefined
  ) {
    const isChildTicket2 =
      (await getParentId(db, tenantId, instanceId)) !== null;
    const updates: Partial<typeof entityInstances.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.assignedTo !== undefined) {
      updates.assignedTo = input.assignedTo;
    }
    if (input.dueDate !== undefined) {
      updates.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    }
    if (input.currentState !== undefined && input.currentState !== null) {
      if (isChildTicket2) {
        if (!CHILD_TICKET_STATES.includes(input.currentState)) {
          throw new ValidationError([
            {
              field: "currentState",
              code: "invalid",
              message: `Child ticket state must be one of: ${CHILD_TICKET_STATES.join(", ")}`,
            },
          ]);
        }
      } else if (existing.workflowId) {
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

    if (row.assignedTo !== null && row.assignedTo !== existing.assignedTo) {
      await db.insert(outboxEvents).values({
        tenantId,
        eventType: "entity.assigned",
        version: 1,
        payload: buildEntityAssignedPayload(
          tenantId,
          row.id,
          row.entityTypeId,
          row.assignedTo,
          resolveAssignedBy(input.actorId, row.createdBy),
          input.depth,
        ),
      });
    }

    // Notifies the user who LOST the assignment, distinct from the above
    // entity.assigned (which only ever notifies the new assignee) —
    // requires a real previous assignee, so this never fires on a
    // first-time assignment (existing.assignedTo === null).
    if (
      existing.assignedTo !== null &&
      row.assignedTo !== existing.assignedTo
    ) {
      await db.insert(outboxEvents).values({
        tenantId,
        eventType: "entity.unassigned",
        version: 1,
        payload: buildEntityUnassignedPayload(
          tenantId,
          row.id,
          row.entityTypeId,
          existing.assignedTo,
          input.actorId ?? null,
          input.depth,
        ),
      });
    }

    if (input.dueDate !== undefined) {
      await rescheduleDueDate(
        db,
        tenantId,
        row.id,
        row.entityTypeId,
        existing.dueDate,
        row.dueDate,
      );
    }

    // Logging logic for assignedTo and/or currentState update
    let effectiveWorkflowId2 = row.workflowId;
    if (!effectiveWorkflowId2) {
      const [parentRel2] = await db
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
      if (parentRel2) {
        const [parent2] = await db
          .select({ workflowId: entityInstances.workflowId })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, parentRel2.toInstanceId),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1);
        effectiveWorkflowId2 = parent2?.workflowId ?? null;
      }
    }
    if (effectiveWorkflowId2) {
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
          workflowId: effectiveWorkflowId2,
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

  // Cascade-cancel (docs/specs/due-date.md R6): a pending overdue trigger for
  // an archived/deleted instance must never fire.
  if (row.dueDate !== null) {
    await rescheduleDueDate(
      db,
      tenantId,
      row.id,
      row.entityTypeId,
      row.dueDate,
      null,
    );
  }

  logger.info({ tenantId, instanceId }, "Entity soft-deleted");

  const [entityType, allFields] = await Promise.all([
    loadEntityType(db, row.entityTypeId, tenantId),
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
  if (input.scopeToUserId !== undefined) {
    // Reuses the exact OR shape apps/api/src/routes/entities/my-tickets.ts
    // already relies on (createdBy/assignedTo/__accessUsers), per
    // docs/specs/workflow-open-ticket-creation.md §I.3 instruction #4 — not a
    // new, separately-indexed path to the same data.
    //
    // entity_instances_fields_gin_idx uses jsonb_path_ops, which supports `@>`
    // containment but not the `?` key-exists operator used in the third
    // branch, so that branch is never index-assisted. EXPLAIN ANALYZE against
    // 20k synthetic rows for one entity_type/tenant (2026-08-05, PR #337
    // review): the planner uses entity_instances_tenant_type_idx
    // (tenant_id, entity_type_id) to narrow the set first, then evaluates
    // this OR as a linear filter over the narrowed rows — 2.8ms, no
    // sequential scan of the full table. Same plan shape my-tickets.ts
    // already produces, so this isn't a regression, just the same
    // already-accepted tradeoff reused at a new call site. Revisit
    // (e.g. an expression index on `fields->'__accessUsers'`, or migrating
    // this branch to `@>` a normalized array column) if per-type row counts
    // grow well past pilot scale.
    // or() with 3 fixed args is always defined — the `| undefined` in its
    // return type only covers the zero-args case, which never happens here.
    const scopeCondition = or(
      eq(entityInstances.createdBy, input.scopeToUserId),
      eq(entityInstances.assignedTo, input.scopeToUserId),
      sql`${entityInstances.fields}->'__accessUsers' ? ${input.scopeToUserId}`,
    );
    if (scopeCondition) conditions.push(scopeCondition);
  }
  if (
    input.fieldFilters !== undefined &&
    Object.keys(input.fieldFilters).length > 0
  ) {
    conditions.push(
      sql`${entityInstances.fields} @> ${JSON.stringify(input.fieldFilters)}::jsonb`,
    );
  }
  if (input.rootOnly) {
    conditions.push(
      notExists(
        db
          .select({ id: entityRelations.id })
          .from(entityRelations)
          .where(
            and(
              eq(entityRelations.tenantId, tenantId),
              eq(entityRelations.fromInstanceId, entityInstances.id),
              eq(entityRelations.relationType, "child_of"),
              isNull(entityRelations.deletedAt),
            ),
          ),
      ),
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
  const entityType = await loadEntityType(db, entityTypeId, tenantId);

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
      sensitivity: field.sensitivity,
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
  tenantId: string,
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

  return {
    ...row,
    tenantId: row.tenantId ?? null,
    moduleId: row.moduleId ?? null,
    icon: row.icon ?? null,
    allowCustomFields: row.allowCustomFields,
  };
}

/** @internal exported for child-relations.ts — not part of the package's public API */
export async function loadEntityFields(
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
    dueDate: row.dueDate ?? null,
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
    actorId: string | undefined;
    entityFields: Array<{ name: string; sensitivity: AuditFieldSensitivity }>;
    depth: number | undefined;
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
      loadEntityType(db, entityTypeId, tenantId),
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
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
    });

    // Save audit context for this item (parallel to toInsert)
    auditMeta.push({
      entityTypeName: entityType.name,
      createdBy: input.createdBy ?? null,
      actorId: input.actorId,
      entityFields: allFields.map((f) => ({
        name: f.name,
        sensitivity: f.sensitivity,
      })),
      depth: input.depth,
    });
  }

  if (toInsert.length === 0) {
    return { created: [], errors };
  }

  const rows = await db.insert(entityInstances).values(toInsert).returning();

  const created = rows.map(rowToInstance);

  // Outbox events for automation triggers (#126) — see createEntity for the
  // PII/financial redaction rationale. depth is threaded through (#218) via
  // auditMeta, the same parallel-array pattern already used for createdBy/
  // actorId. Sensitivity maps are cached per entity type (via typeMetaCache,
  // already populated above) rather than rebuilt per row.
  const sensitivityByType = new Map<string, Map<string, FieldSensitivity>>();
  function getSensitivityMap(
    entityTypeId: string,
  ): Map<string, FieldSensitivity> {
    const cached = sensitivityByType.get(entityTypeId);
    if (cached) return cached;
    const typeMeta = typeMetaCache.get(entityTypeId);
    if (!typeMeta) {
      // Every entityTypeId reaching this point came from a row the validation
      // loop above already accepted, which always populates typeMetaCache for
      // that type first — this should be unreachable. Failing loudly here
      // instead of falling back to `?? []` matters because an empty
      // sensitivity map makes redactFields redact nothing: a silent fallback
      // would fail OPEN on a security-sensitive property (PII/financial
      // fields would leak into the outbox unredacted).
      throw new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId });
    }
    const map = buildSensitivityMap(typeMeta.allFields);
    sensitivityByType.set(entityTypeId, map);
    return map;
  }
  const outboxRows = rows.flatMap((row, idx) => {
    const events: Array<EntityCreatedEvent | EntityAssignedEvent> = [
      buildEntityCreatedPayload(
        tenantId,
        row.id,
        row.entityTypeId,
        redactFields(
          row.fields as Record<string, unknown>,
          getSensitivityMap(row.entityTypeId),
        ),
        row.createdBy,
        auditMeta[idx]?.depth,
      ),
    ];
    if (row.assignedTo !== null) {
      events.push(
        buildEntityAssignedPayload(
          tenantId,
          row.id,
          row.entityTypeId,
          row.assignedTo,
          resolveAssignedBy(auditMeta[idx]?.actorId, row.createdBy),
          auditMeta[idx]?.depth,
        ),
      );
    }
    return events;
  });
  if (outboxRows.length > 0) {
    await db.insert(outboxEvents).values(
      outboxRows.map((payload) => ({
        tenantId,
        eventType: payload.eventType,
        version: 1,
        payload,
      })),
    );
  }

  await Promise.all(
    rows
      .filter((row) => row.dueDate !== null)
      .map((row) =>
        rescheduleDueDate(
          db,
          tenantId,
          row.id,
          row.entityTypeId,
          null,
          row.dueDate,
        ),
      ),
  );

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
  // Collected across all items and inserted once after Promise.all, instead
  // of one insert per item (#126 review: bulkCreateEntities already batches
  // its outbox rows; this matches that pattern instead of doing N round trips).
  const assignedOutboxRows: Array<
    | {
        tenantId: string;
        eventType: "entity.assigned";
        version: 1;
        payload: EntityAssignedEvent;
      }
    | {
        tenantId: string;
        eventType: "entity.unassigned";
        version: 1;
        payload: EntityUnassignedEvent;
      }
  > = [];

  // Fetch all rows in one query instead of one SELECT per item (#196 N+1) —
  // mirrors bulkSetState's foundMap pattern below. Per-row UPDATEs still
  // happen individually since each item's `fields`/`assignedTo` payload is
  // heterogeneous (unlike bulkSetState's small set of distinct target
  // states, which groups into one UPDATE per state) — batching those would
  // need a VALUES-based multi-row UPDATE not used anywhere else in this
  // file, so this fixes the read side only, per the confirmed-real half of
  // #196.
  const existingRows =
    updates.length > 0
      ? await db
          .select()
          .from(entityInstances)
          .where(
            and(
              inArray(
                entityInstances.id,
                updates.map((u) => u.id),
              ),
              eq(entityInstances.tenantId, tenantId),
              isNull(entityInstances.deletedAt),
            ),
          )
      : [];
  const existingMap = new Map(existingRows.map((r) => [r.id, r]));

  await Promise.all(
    updates.map(async ({ id, input }, i) => {
      const existing = existingMap.get(id);

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

        const entityType = await loadEntityType(
          db,
          existing.entityTypeId,
          tenantId,
        );
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
        if (input.dueDate !== undefined) {
          updateValues.dueDate = input.dueDate ? new Date(input.dueDate) : null;
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
          if (
            row.assignedTo !== null &&
            row.assignedTo !== existing.assignedTo
          ) {
            assignedOutboxRows.push({
              tenantId,
              eventType: "entity.assigned",
              version: 1,
              payload: buildEntityAssignedPayload(
                tenantId,
                row.id,
                row.entityTypeId,
                row.assignedTo,
                resolveAssignedBy(input.actorId, row.createdBy),
                input.depth,
              ),
            });
          }
          // See the singular updateEntity's identical comment above.
          if (
            existing.assignedTo !== null &&
            row.assignedTo !== existing.assignedTo
          ) {
            assignedOutboxRows.push({
              tenantId,
              eventType: "entity.unassigned",
              version: 1,
              payload: buildEntityUnassignedPayload(
                tenantId,
                row.id,
                row.entityTypeId,
                existing.assignedTo,
                input.actorId ?? null,
                input.depth,
              ),
            });
          }
          if (input.dueDate !== undefined) {
            await rescheduleDueDate(
              db,
              tenantId,
              row.id,
              row.entityTypeId,
              existing.dueDate,
              row.dueDate,
            );
          }
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
      } else if (
        input.assignedTo !== undefined ||
        input.dueDate !== undefined
      ) {
        const updateValues: Partial<typeof entityInstances.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (input.assignedTo !== undefined) {
          updateValues.assignedTo = input.assignedTo;
        }
        if (input.dueDate !== undefined) {
          updateValues.dueDate = input.dueDate ? new Date(input.dueDate) : null;
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
          if (
            row.assignedTo !== null &&
            row.assignedTo !== existing.assignedTo
          ) {
            assignedOutboxRows.push({
              tenantId,
              eventType: "entity.assigned",
              version: 1,
              payload: buildEntityAssignedPayload(
                tenantId,
                row.id,
                row.entityTypeId,
                row.assignedTo,
                resolveAssignedBy(input.actorId, row.createdBy),
                input.depth,
              ),
            });
          }
          // See the singular updateEntity's identical comment above.
          if (
            existing.assignedTo !== null &&
            row.assignedTo !== existing.assignedTo
          ) {
            assignedOutboxRows.push({
              tenantId,
              eventType: "entity.unassigned",
              version: 1,
              payload: buildEntityUnassignedPayload(
                tenantId,
                row.id,
                row.entityTypeId,
                existing.assignedTo,
                input.actorId ?? null,
                input.depth,
              ),
            });
          }
          if (input.dueDate !== undefined) {
            await rescheduleDueDate(
              db,
              tenantId,
              row.id,
              row.entityTypeId,
              existing.dueDate,
              row.dueDate,
            );
          }
          // Load entity type for audit — not needed for the fields update path
          // above (entityType is already available there) but needed here.
          const [bulkEntityType, bulkAllFields] = await Promise.all([
            loadEntityType(db, existing.entityTypeId, tenantId),
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

  if (assignedOutboxRows.length > 0) {
    await db.insert(outboxEvents).values(assignedOutboxRows);
  }

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
  actorId?: string,
): Promise<BulkSetStateResult> {
  if (items.length === 0) return { updatedIds: [], errors: [] };

  const ids = items.map((item) => item.id);

  // Load all matching instances in one query to verify tenant ownership.
  // Also fetch entityTypeId, currentState and workflowId for audit hooks and
  // the workflow_events/outbox writes below (#127 — this was previously a
  // silent state side-door with no audit trail and no automation trigger).
  const existing = await db
    .select({
      id: entityInstances.id,
      entityTypeId: entityInstances.entityTypeId,
      currentState: entityInstances.currentState,
      workflowId: entityInstances.workflowId,
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
  // Carries each item's ORIGINAL `items` array index alongside it, rather
  // than deriving the index later from a `Map` keyed by id — a Map keyed by
  // id collapses to the LAST occurrence if the same id appears twice in one
  // batch (nothing rejects duplicate ids upstream), which would report the
  // wrong index for an earlier occurrence's error.
  const validItems: Array<{
    id: string;
    state: string;
    originalIndex: number;
  }> = [];

  for (const [i, item] of items.entries()) {
    if (!foundIds.has(item.id)) {
      errors.push({ index: i, id: item.id, code: "ENTITY_NOT_FOUND" });
    } else {
      validItems.push({ ...item, originalIndex: i });
    }
  }

  if (validItems.length === 0) return { updatedIds: [], errors };

  // #160 — mirrors updateEntity's validation: a child ticket (inherits its
  // parent's workflowId) must be restricted to the fixed
  // open/in-progress/closed set, not validated against the PARENT's full
  // workflow_states. One batched entity_relations lookup across all ids in
  // the batch, not a per-item getParentId call.
  const childIds = new Set(
    (
      await db
        .select({ fromInstanceId: entityRelations.fromInstanceId })
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.tenantId, tenantId),
            inArray(
              entityRelations.fromInstanceId,
              validItems.map((item) => item.id),
            ),
            eq(entityRelations.relationType, "child_of"),
            isNull(entityRelations.deletedAt),
          ),
        )
    ).map((r) => r.fromInstanceId),
  );

  // Validate each item's target state against ITS OWN bound workflow's
  // workflow_states, not a single flat set across the whole batch: items in
  // this call may belong to different workflows, and a state name valid in
  // one could be invalid in another. One batched lookup keyed on distinct
  // workflowIds present in validItems (excluding child tickets, which never
  // consult workflow_states), not per-item.
  const workflowIds = [
    ...new Set(
      validItems
        .filter((item) => !childIds.has(item.id))
        .map((item) => foundMap.get(item.id)?.workflowId)
        .filter((w): w is string => !!w),
    ),
  ];
  const statesByWorkflow = new Map<string, Set<string>>();
  if (workflowIds.length > 0) {
    const stateRows = await db
      .select({
        workflowId: workflowStates.workflowId,
        name: workflowStates.name,
      })
      .from(workflowStates)
      .where(inArray(workflowStates.workflowId, workflowIds));
    for (const r of stateRows) {
      const set = statesByWorkflow.get(r.workflowId) ?? new Set<string>();
      set.add(r.name);
      statesByWorkflow.set(r.workflowId, set);
    }
  }

  const stateValidatedItems: Array<{ id: string; state: string }> = [];
  for (const item of validItems) {
    if (childIds.has(item.id)) {
      if (!CHILD_TICKET_STATES.includes(item.state)) {
        errors.push({
          index: item.originalIndex,
          id: item.id,
          code: "INVALID_STATE",
        });
        continue;
      }
      stateValidatedItems.push(item);
      continue;
    }
    const workflowId = foundMap.get(item.id)?.workflowId;
    if (workflowId && !statesByWorkflow.get(workflowId)?.has(item.state)) {
      errors.push({
        index: item.originalIndex,
        id: item.id,
        code: "INVALID_STATE",
      });
      continue;
    }
    stateValidatedItems.push(item);
  }

  if (stateValidatedItems.length === 0) return { updatedIds: [], errors };

  // Group by target state — one UPDATE per unique state value
  const byState = new Map<string, string[]>();
  for (const item of stateValidatedItems) {
    const bucket = byState.get(item.state) ?? [];
    bucket.push(item.id);
    byState.set(item.state, bucket);
  }

  const updatedIds: string[] = [];
  const workflowEventRows: Array<typeof workflowEvents.$inferInsert> = [];
  const outboxRows: Array<{
    tenantId: string;
    eventType: "workflow.transitioned";
    version: 1;
    payload: Record<string, unknown>;
  }> = [];
  const occurredAt = new Date();

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

    for (const row of rows) {
      const prior = foundMap.get(row.id);
      if (!prior?.workflowId || prior.currentState === state) {
        continue;
      }
      workflowEventRows.push({
        tenantId,
        instanceId: row.id,
        workflowId: prior.workflowId,
        fromState: prior.currentState,
        toState: state,
        triggeredBy: "user",
        actorId: actorId ?? null,
        comment: `State set directly to ${state}`,
        metadata: { type: "direct-set" },
      });
      outboxRows.push({
        tenantId,
        eventType: "workflow.transitioned",
        version: 1,
        payload: {
          eventType: "workflow.transitioned",
          version: 1,
          tenantId,
          instanceId: row.id,
          entityTypeId: prior.entityTypeId,
          workflowId: prior.workflowId,
          fromState: prior.currentState,
          toState: state,
          triggeredBy: "user",
          actorId: actorId ?? null,
          occurredAt: occurredAt.toISOString(),
        },
      });
    }
  }

  if (workflowEventRows.length > 0) {
    await db.insert(workflowEvents).values(workflowEventRows);
  }
  if (outboxRows.length > 0) {
    await db.insert(outboxEvents).values(outboxRows);
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

  for (const item of stateValidatedItems) {
    const prior = foundMap.get(item.id);
    if (!prior) continue;

    if (!typeCache.has(prior.entityTypeId)) {
      const [et, ef] = await Promise.all([
        loadEntityType(db, prior.entityTypeId, tenantId),
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
  actorId?: string,
): Promise<EntityInstance> {
  const [existing] = await db
    .select({
      id: entityInstances.id,
      entityTypeId: entityInstances.entityTypeId,
      currentState: entityInstances.currentState,
      workflowId: entityInstances.workflowId,
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

  // #160 — mirrors updateEntity's existing workflow_states validation (both
  // branches: the child-ticket fixed-state-list check AND the workflow_states
  // lookup). This direct state-set previously accepted any string, letting an
  // admin/agent push an entity into an undefined state name — or, for a child
  // ticket, into a state outside its restricted open/in-progress/closed set
  // (children inherit their parent's workflowId, so without this check they'd
  // validate against the PARENT's full workflow states instead).
  const isChildTicket = (await getParentId(db, tenantId, instanceId)) !== null;
  if (isChildTicket) {
    if (!CHILD_TICKET_STATES.includes(state)) {
      throw new ValidationError([
        {
          field: "state",
          code: "invalid",
          message: `Child ticket state must be one of: ${CHILD_TICKET_STATES.join(", ")}`,
        },
      ]);
    }
  } else if (existing.workflowId) {
    const states = await db
      .select({ name: workflowStates.name })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, existing.workflowId));
    const validStates = states.map((s) => s.name);
    if (!validStates.includes(state)) {
      throw new ValidationError([
        {
          field: "state",
          code: "invalid",
          message: `Invalid state '${state}' for the workflow. Valid states are: ${validStates.join(", ")}`,
        },
      ]);
    }
  }

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

  // #127 — this direct state-set previously wrote no workflow_events row and
  // no outbox event, making it a silent side-door around executeTransition's
  // audit trail and automation triggers. Mirrors the existing accepted
  // pattern for direct currentState writes in updateEntity() above.
  if (existing.workflowId && existing.currentState !== state) {
    await db.insert(workflowEvents).values({
      tenantId,
      instanceId,
      workflowId: existing.workflowId,
      fromState: existing.currentState,
      toState: state,
      triggeredBy: "user",
      actorId: actorId ?? null,
      comment: `State set directly to ${state}`,
      metadata: { type: "direct-set" },
    });

    await db.insert(outboxEvents).values({
      tenantId,
      eventType: "workflow.transitioned",
      version: 1,
      payload: {
        eventType: "workflow.transitioned",
        version: 1,
        tenantId,
        instanceId,
        entityTypeId: existing.entityTypeId,
        workflowId: existing.workflowId,
        fromState: existing.currentState,
        toState: state,
        triggeredBy: "user",
        actorId: actorId ?? null,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  const [entityType, allFields] = await Promise.all([
    loadEntityType(db, existing.entityTypeId, tenantId),
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
