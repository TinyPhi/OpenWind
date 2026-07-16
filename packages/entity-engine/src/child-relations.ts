import { eq, and, isNull, or, sql, count, inArray } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityRelations,
  entityInstances,
  workflows,
  workflowEvents,
  outboxEvents,
} from "@platform/db";
import {
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./pagination.js";
import { logger } from "@platform/logger";
import { EntityError } from "./errors.js";
import { buildEntityCreatedPayload, loadEntityFields } from "./engine.js";
import { redactFields, buildSensitivityMap } from "./redact.js";
import type {
  EntityInstance,
  EntityRelation,
  CreateChildRelationInput,
  MoveChildRelationInput,
} from "./types.js";

export const RELATION_PARENT_OF = "parent_of";
export const RELATION_CHILD_OF = "child_of";

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Walk up the ancestor chain; return the number of ancestor levels above instanceId. */
export async function getAncestorDepth(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<number> {
  let current = instanceId;
  let depth = 0;
  // Bounded by a practical max to prevent runaway queries on corrupt data
  const HARD_MAX = 20;
  while (depth < HARD_MAX) {
    const [parentRel] = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_CHILD_OF),
          isNull(entityRelations.deletedAt),
        ),
      )
      .limit(1);
    if (!parentRel) break;
    current = parentRel.toInstanceId;
    depth++;
  }
  return depth;
}

/** Walk down the descendant chain; return the max depth below instanceId. */
async function getDescendantDepth(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<number> {
  const children = await db
    .select({ toInstanceId: entityRelations.toInstanceId })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.fromInstanceId, instanceId),
        eq(entityRelations.relationType, RELATION_PARENT_OF),
        isNull(entityRelations.deletedAt),
      ),
    );
  if (children.length === 0) return 0;
  let max = 0;
  for (const child of children) {
    const d = await getDescendantDepth(db, tenantId, child.toInstanceId);
    if (d + 1 > max) max = d + 1;
  }
  return max;
}

/** Collect all descendant instance IDs (not including instanceId itself). */
async function collectDescendantIds(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  includeSoftDeleted = false,
): Promise<string[]> {
  const result: string[] = [];
  const queue = [instanceId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const cond = includeSoftDeleted
      ? and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_PARENT_OF),
        )
      : and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_PARENT_OF),
          isNull(entityRelations.deletedAt),
        );
    const children = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(cond);
    for (const c of children) {
      result.push(c.toInstanceId);
      queue.push(c.toInstanceId);
    }
  }
  return result;
}

/**
 * Load workflow limits for the given workflow ID, scoped to this tenant (or
 * a NULL-tenant system/template workflow — workflows has no RLS policy, see
 * db-conventions.md, so this explicit filter is the only tenant guard here).
 */
async function loadWorkflowLimits(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
): Promise<{ maxChildDepth: number; maxChildrenPerParent: number }> {
  const [wf] = await db
    .select({
      maxChildDepth: workflows.maxChildDepth,
      maxChildrenPerParent: workflows.maxChildrenPerParent,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        or(isNull(workflows.tenantId), eq(workflows.tenantId, tenantId)),
      ),
    )
    .limit(1);
  if (!wf) throw new EntityError("ENTITY_NOT_FOUND", { workflowId });
  return wf;
}

/** Count active (non-archived) direct children of parentId. */
async function countActiveChildren(
  db: DbOrTx,
  tenantId: string,
  parentId: string,
): Promise<number> {
  const [result] = await db
    .select({ n: count() })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.fromInstanceId, parentId),
        eq(entityRelations.relationType, RELATION_PARENT_OF),
        isNull(entityRelations.deletedAt),
      ),
    );
  return result?.n ?? 0;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Create a child ticket under parentId.
 * Inserts entity_instance + parent_of + child_of in one transaction.
 * Validates: children enabled, one-parent, depth limit, children cap.
 */
export async function createChildRelation(
  db: DbOrTx,
  tenantId: string,
  input: CreateChildRelationInput,
): Promise<{ instance: EntityInstance; relations: EntityRelation[] }> {
  const { parentId, childFields, entityTypeId, assignedTo, createdBy } = input;

  // Load parent — lock row to prevent concurrent race on cap/depth
  const [parent] = await db
    .select({
      id: entityInstances.id,
      workflowId: entityInstances.workflowId,
      deletedAt: entityInstances.deletedAt,
    })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, parentId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .for("update")
    .limit(1);

  if (!parent || parent.deletedAt) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: parentId });
  }

  // Workflow limits — parent must have a workflow_id (top-level ticket)
  if (!parent.workflowId) {
    throw new EntityError("CHILDREN_DISABLED", {
      instanceId: parentId,
      reason: "parent has no workflow",
    });
  }
  const limits = await loadWorkflowLimits(db, tenantId, parent.workflowId);

  if (limits.maxChildDepth === 0) {
    throw new EntityError("CHILDREN_DISABLED", {
      instanceId: parentId,
      workflowId: parent.workflowId,
    });
  }

  // One-parent constraint on the parent itself: is parent already a child?
  // If so, adding children to it would increase chain depth
  const ancestorDepth = await getAncestorDepth(db, tenantId, parentId);
  // New chain = ancestorDepth (levels above parent) + 1 (parent→child link)
  const newChainDepth = ancestorDepth + 1;
  if (newChainDepth > limits.maxChildDepth) {
    throw new EntityError("CHILD_DEPTH_EXCEEDED", {
      instanceId: parentId,
      currentDepth: newChainDepth,
      maxDepth: limits.maxChildDepth,
    });
  }

  // Children cap
  const childCount = await countActiveChildren(db, tenantId, parentId);
  if (childCount >= limits.maxChildrenPerParent) {
    throw new EntityError("CHILDREN_CAP_EXCEEDED", {
      instanceId: parentId,
      cap: limits.maxChildrenPerParent,
    });
  }

  // Insert child instance — inherit parent's workflowId so comments/history work
  const [childInstance] = await db
    .insert(entityInstances)
    .values({
      tenantId,
      entityTypeId,
      workflowId: parent.workflowId,
      fields: {
        ...childFields,
        child_status: "open",
        // Seed access list with assignee (if any) — stored as {userId: {level, tag}}
        __accessUsers: assignedTo
          ? { [assignedTo]: { level: "read_write", tag: "assigned" } }
          : {},
      },
      assignedTo: assignedTo ?? null,
      createdBy: createdBy ?? null,
      currentState: "open",
    })
    .returning();

  if (!childInstance) throw new EntityError("ENTITY_NOT_FOUND", {});

  // Emit create event so history and comments work on the child
  await db.insert(workflowEvents).values({
    tenantId,
    instanceId: childInstance.id,
    workflowId: parent.workflowId,
    fromState: null,
    toState: "open",
    triggeredBy: "user",
    actorId: createdBy ?? "system",
    comment: null,
    metadata: { type: "create", actorName: createdBy ?? null },
  });

  // Outbox event for entity.created automations (#126) — child tickets go
  // through this path, not createEntity, so they need their own emission.
  const allFields = await loadEntityFields(db, entityTypeId, tenantId);
  const redactedFieldsForEvents = redactFields(
    childInstance.fields as Record<string, unknown>,
    buildSensitivityMap(allFields),
  );
  await db.insert(outboxEvents).values({
    tenantId,
    eventType: "entity.created",
    version: 1,
    payload: buildEntityCreatedPayload(
      tenantId,
      childInstance.id,
      entityTypeId,
      redactedFieldsForEvents,
      childInstance.createdBy,
    ),
  });

  // Insert both relation rows atomically
  const relationRows = await db
    .insert(entityRelations)
    .values([
      {
        tenantId,
        fromInstanceId: parentId,
        toInstanceId: childInstance.id,
        relationType: RELATION_PARENT_OF,
      },
      {
        tenantId,
        fromInstanceId: childInstance.id,
        toInstanceId: parentId,
        relationType: RELATION_CHILD_OF,
      },
    ])
    .returning();

  logger.info(
    { tenantId, parentId, childId: childInstance.id },
    "Child ticket created",
  );

  return {
    instance: rowToInstance(childInstance),
    relations: relationRows.map(rowToRelation),
  };
}

/**
 * Re-parent a child ticket to a new parent, or detach it (newParentId = null).
 * Validates depth, cap, cycle, one-parent on the new parent chain.
 * Atomic: old relation pair soft-deleted, new pair inserted in one go.
 */
export async function moveChildRelation(
  db: DbOrTx,
  tenantId: string,
  input: MoveChildRelationInput,
): Promise<EntityRelation[]> {
  const { childId, newParentId } = input;

  // Lock child row
  const [child] = await db
    .select({ id: entityInstances.id, deletedAt: entityInstances.deletedAt })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, childId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .for("update")
    .limit(1);

  if (!child || child.deletedAt) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: childId });
  }

  // Soft-delete existing child_of + parent_of pair
  await db
    .update(entityRelations)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.fromInstanceId, childId),
        eq(entityRelations.relationType, RELATION_CHILD_OF),
        isNull(entityRelations.deletedAt),
      ),
    );

  // Also soft-delete the mirrored parent_of row on the old parent
  const [oldParentOf] = await db
    .select({ id: entityRelations.id })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.toInstanceId, childId),
        eq(entityRelations.relationType, RELATION_PARENT_OF),
        isNull(entityRelations.deletedAt),
      ),
    )
    .limit(1);
  if (oldParentOf) {
    await db
      .update(entityRelations)
      .set({ deletedAt: sql`now()` })
      .where(eq(entityRelations.id, oldParentOf.id));
  }

  if (!newParentId) {
    // Detach: remove child_status from fields, clear currentState to "initial"
    await db
      .update(entityInstances)
      .set({
        fields: sql`fields - 'child_status'`,
        currentState: "initial",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(entityInstances.id, childId),
          eq(entityInstances.tenantId, tenantId),
        ),
      );

    logger.info({ tenantId, childId }, "Child ticket detached");
    return [];
  }

  // Validate new parent
  const [newParent] = await db
    .select({
      id: entityInstances.id,
      workflowId: entityInstances.workflowId,
      deletedAt: entityInstances.deletedAt,
    })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, newParentId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .for("update")
    .limit(1);

  if (!newParent || newParent.deletedAt) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: newParentId });
  }

  if (!newParent.workflowId) {
    throw new EntityError("CHILDREN_DISABLED", {
      instanceId: newParentId,
      reason: "new parent has no workflow",
    });
  }

  const limits = await loadWorkflowLimits(db, tenantId, newParent.workflowId);

  if (limits.maxChildDepth === 0) {
    throw new EntityError("CHILDREN_DISABLED", {
      instanceId: newParentId,
    });
  }

  // Cycle detection: newParentId must not be childId itself, nor a descendant
  // of childId (collectDescendantIds excludes the instance itself, so the
  // self-parent case must be checked explicitly).
  const descendants = await collectDescendantIds(db, tenantId, childId);
  if (newParentId === childId || descendants.includes(newParentId)) {
    throw new EntityError("CHILD_CYCLE_DETECTED", {
      childId,
      newParentId,
    });
  }

  // Depth check: ancestors of newParent + 1 (link) + descendants of child
  const ancestorDepth = await getAncestorDepth(db, tenantId, newParentId);
  const descendantDepth = await getDescendantDepth(db, tenantId, childId);
  const newChainDepth = ancestorDepth + 1 + descendantDepth;
  if (newChainDepth > limits.maxChildDepth) {
    throw new EntityError("CHILD_DEPTH_EXCEEDED", {
      childId,
      newParentId,
      currentDepth: newChainDepth,
      maxDepth: limits.maxChildDepth,
    });
  }

  // Cap check on new parent
  const childCount = await countActiveChildren(db, tenantId, newParentId);
  if (childCount >= limits.maxChildrenPerParent) {
    throw new EntityError("CHILDREN_CAP_EXCEEDED", {
      instanceId: newParentId,
      cap: limits.maxChildrenPerParent,
    });
  }

  // Insert new relation pair
  const newRelations = await db
    .insert(entityRelations)
    .values([
      {
        tenantId,
        fromInstanceId: newParentId,
        toInstanceId: childId,
        relationType: RELATION_PARENT_OF,
      },
      {
        tenantId,
        fromInstanceId: childId,
        toInstanceId: newParentId,
        relationType: RELATION_CHILD_OF,
      },
    ])
    .returning();

  logger.info({ tenantId, childId, newParentId }, "Child ticket re-parented");

  return newRelations.map(rowToRelation);
}

/**
 * Returns true if userId can read instanceId.
 * Admin/agent: always true.
 * Otherwise: check direct assignment OR assignment on any ancestor.
 */
export async function canUserReadInstance(
  db: DbOrTx,
  tenantId: string,
  userId: string,
  userRole: string,
  instanceId: string,
): Promise<boolean> {
  if (userRole === "admin" || userRole === "agent") return true;

  // Direct assignment check
  const [inst] = await db
    .select({ assignedTo: entityInstances.assignedTo })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);

  if (!inst) return false;
  if (inst.assignedTo === userId) return true;

  // Walk up ancestor chain (bounded by HARD_MAX)
  let current = instanceId;
  const HARD_MAX = 20;
  for (let i = 0; i < HARD_MAX; i++) {
    const [parentRel] = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_CHILD_OF),
          isNull(entityRelations.deletedAt),
        ),
      )
      .limit(1);
    if (!parentRel) break;

    const [ancestor] = await db
      .select({ assignedTo: entityInstances.assignedTo })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.id, parentRel.toInstanceId),
          eq(entityInstances.tenantId, tenantId),
          isNull(entityInstances.deletedAt),
        ),
      )
      .limit(1);

    if (ancestor?.assignedTo === userId) return true;
    current = parentRel.toInstanceId;
  }

  return false;
}

/** Get the parent instance ID of a ticket, or null if top-level. */
export async function getParentId(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<string | null> {
  const [rel] = await db
    .select({ toInstanceId: entityRelations.toInstanceId })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.fromInstanceId, instanceId),
        eq(entityRelations.relationType, RELATION_CHILD_OF),
        isNull(entityRelations.deletedAt),
      ),
    )
    .limit(1);
  return rel?.toInstanceId ?? null;
}

/** Count active direct children of parentId. */
export { countActiveChildren };

/**
 * List the active child instances of parentId, ordered by relation creation time.
 * Returns a cursor page of EntityInstance rows.
 */
export async function listChildInstances(
  db: DbOrTx,
  tenantId: string,
  parentId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ data: EntityInstance[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;

  const relRows = await db
    .select({
      toInstanceId: entityRelations.toInstanceId,
      createdAt: entityRelations.createdAt,
      id: entityRelations.id,
    })
    .from(entityRelations)
    .where(
      and(
        eq(entityRelations.tenantId, tenantId),
        eq(entityRelations.fromInstanceId, parentId),
        eq(entityRelations.relationType, RELATION_PARENT_OF),
        isNull(entityRelations.deletedAt),
        ...(decoded
          ? [
              sql`(${entityRelations.createdAt}, ${entityRelations.id}) > (${decoded.createdAt.toISOString()}::timestamptz, ${decoded.id})`,
            ]
          : []),
      ),
    )
    .orderBy(entityRelations.createdAt, entityRelations.id)
    .limit(limit + 1);

  const hasMore = relRows.length > limit;
  const pageRows = hasMore ? relRows.slice(0, limit) : relRows;
  const childIds = pageRows.map((r) => r.toInstanceId);

  if (childIds.length === 0) return { data: [], nextCursor: null };

  const instances = await db
    .select()
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        inArray(entityInstances.id, childIds),
        isNull(entityInstances.deletedAt),
      ),
    );

  // Preserve relation order
  const byId = new Map(instances.map((i) => [i.id, i]));
  const ordered = childIds.flatMap((id) => {
    const i = byId.get(id);
    return i ? [rowToInstance(i)] : [];
  });

  const lastRel = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRel ? encodeCursor(lastRel.createdAt, lastRel.id) : null;

  return { data: ordered, nextCursor };
}

// ── Row mappers ────────────────────────────────────────────────────────────────

function rowToInstance(
  row: typeof entityInstances.$inferSelect,
): EntityInstance {
  return {
    id: row.id,
    entityTypeId: row.entityTypeId,
    tenantId: row.tenantId,
    workflowId: row.workflowId,
    currentState: row.currentState,
    fields: row.fields as Record<string, unknown>,
    createdBy: row.createdBy,
    assignedTo: row.assignedTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
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
