import { eq, and, or, isNull, asc, inArray, count, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  workflows,
  workflowStates,
  workflowTransitions,
  entityInstances,
} from "@platform/db";
import { logger } from "@platform/logger";
import { WorkflowError } from "./errors.js";
import { isWorkflowAdmin, isWorkflowAdminListEditor } from "./authorization.js";
import type {
  WorkflowDefinition,
  WorkflowFull,
  WorkflowState,
  WorkflowTransition,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  CreateWorkflowStateInput,
  UpdateWorkflowStateInput,
  CreateWorkflowTransitionInput,
  UpdateWorkflowTransitionInput,
  ConditionTree,
  WorkflowCaller,
} from "./types.js";

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToWorkflow(r: typeof workflows.$inferSelect): WorkflowDefinition {
  return {
    id: r.id,
    tenantId: r.tenantId ?? null,
    entityTypeId: r.entityTypeId,
    name: r.name,
    initialState: r.initialState,
    isActive: r.isActive,
    createdBy: r.createdBy ?? null,
    assignedTo: (r.assignedTo as string[] | null) ?? [],
    maxChildDepth: r.maxChildDepth,
    maxChildrenPerParent: r.maxChildrenPerParent,
    createdAt: r.createdAt,
  };
}

function rowToState(r: typeof workflowStates.$inferSelect): WorkflowState {
  return {
    id: r.id,
    workflowId: r.workflowId,
    name: r.name,
    label: r.label,
    color: r.color ?? null,
    isTerminal: r.isTerminal,
    slaHours: r.slaHours ?? null,
    sortOrder: r.sortOrder,
  };
}

function rowToTransition(
  r: typeof workflowTransitions.$inferSelect,
): WorkflowTransition {
  return {
    id: r.id,
    workflowId: r.workflowId,
    fromState: r.fromState,
    toState: r.toState,
    label: r.label ?? null,
    allowedRoles: r.allowedRoles,
    conditions: (r.conditions as ConditionTree | null) ?? null,
    requiresComment: r.requiresComment,
    requiresFields: r.requiresFields,
  };
}

// ── Workflow visibility predicate ─────────────────────────────────────────────
// Tenants can read system workflows (tenantId = null) and their own.
// Writes (create/delete states/transitions) are restricted to tenant-owned rows.

function visibleTo(tenantId: string): ReturnType<typeof or> {
  return or(isNull(workflows.tenantId), eq(workflows.tenantId, tenantId));
}

// Matches rows where the caller is the creator or a member of assigned_to.
// System template rows (tenantId=null) have no owner and are handled
// separately by visibleTo — every tenant user can read those.
function ownedByCaller(caller: WorkflowCaller): ReturnType<typeof or> {
  return or(
    eq(workflows.createdBy, caller.userId),
    sql`${workflows.assignedTo} @> ARRAY[${caller.userId}]::text[]`,
  );
}

// ── Workflow CRUD ─────────────────────────────────────────────────────────────

export async function createWorkflow(
  db: DbOrTx,
  tenantId: string,
  createdBy: string,
  input: CreateWorkflowInput,
): Promise<WorkflowDefinition> {
  const [row] = await db
    .insert(workflows)
    .values({
      tenantId,
      entityTypeId: input.entityTypeId,
      name: input.name,
      initialState: input.initialState,
      createdBy,
      assignedTo: [createdBy],
    })
    .returning();

  if (!row) throw new WorkflowError("WORKFLOW_NOT_FOUND");

  logger.info({ tenantId, workflowId: row.id, createdBy }, "Workflow created");
  return rowToWorkflow(row);
}

// Resolves the workflow that owns a given entity type — used to authorize
// field mutations (apps/api/src/routes/entity-types/fields/*), which live on
// the entity type but should follow the same per-workflow admin model.
export async function getWorkflowByEntityTypeId(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
): Promise<WorkflowDefinition | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.entityTypeId, entityTypeId),
        eq(workflows.tenantId, tenantId),
      ),
    )
    .limit(1);
  return row ? rowToWorkflow(row) : null;
}

// Deliberately not ownership-filtered: viewing a workflow's structure
// (states/transitions/createdBy/assignedTo — no secrets) is needed by any
// tenant member working with its records, e.g. a ticket assignee viewing
// their record's state options, not just the workflow's admins. Per-workflow
// ownership is enforced on the *mutation* routes (assertWorkflowOwned,
// updateWorkflow, deleteWorkflow, canvas.ts) and, for the admin-only settings
// page specifically, client-side in admin-ui using the createdBy/assignedTo
// this call returns. `caller` is accepted for API-shape consistency with the
// other workflow-crud functions but unused here — every tenant member reads
// the same data regardless of role.
export async function getWorkflow(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  _caller: WorkflowCaller,
): Promise<WorkflowFull> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), visibleTo(tenantId)))
    .limit(1);

  if (!row) throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });

  const [states, transitions] = await Promise.all([
    db
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId))
      .orderBy(asc(workflowStates.sortOrder), asc(workflowStates.id)),
    db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflowId))
      .orderBy(asc(workflowTransitions.id)),
  ]);

  return {
    ...rowToWorkflow(row),
    states: states.map(rowToState),
    transitions: transitions.map(rowToTransition),
  };
}

// Lightweight variant for callers that only need id/name/entityTypeId (e.g. slug
// resolution) — skips the states/transitions/record-count joins list() does.
export async function listWorkflowsSummary(
  db: DbOrTx,
  tenantId: string,
  caller: WorkflowCaller,
  entityTypeId?: string,
  activeOnly?: boolean,
): Promise<WorkflowDefinition[]> {
  const visibility = caller.isGlobalAdmin
    ? visibleTo(tenantId)
    : or(isNull(workflows.tenantId), ownedByCaller(caller));

  const baseFilter = entityTypeId
    ? and(eq(workflows.entityTypeId, entityTypeId), visibility)
    : visibility;
  const filter = activeOnly
    ? and(baseFilter, eq(workflows.isActive, true))
    : baseFilter;

  const rows = await db
    .select()
    .from(workflows)
    .where(filter)
    .orderBy(asc(workflows.createdAt));

  return rows.map(rowToWorkflow);
}

// Tenant-wide id/name pairs, deliberately NOT ownership-filtered — used only
// to resolve a human-readable URL slug to a workflow id before the real
// per-workflow authorization check (getWorkflow) runs. Knowing a workflow's
// name/id within your own tenant isn't a new disclosure: listWorkflows was
// unfiltered for every tenant member before the ownership model existed, and
// the detail fetch that follows still enforces the real access check.
export async function listWorkflowSlugs(
  db: DbOrTx,
  tenantId: string,
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(visibleTo(tenantId));
}

export async function listWorkflows(
  db: DbOrTx,
  tenantId: string,
  caller: WorkflowCaller,
  entityTypeId?: string,
  activeOnly?: boolean,
): Promise<WorkflowFull[]> {
  const visibility = caller.isGlobalAdmin
    ? visibleTo(tenantId)
    : or(isNull(workflows.tenantId), ownedByCaller(caller));

  const baseFilter = entityTypeId
    ? and(eq(workflows.entityTypeId, entityTypeId), visibility)
    : visibility;
  const filter = activeOnly
    ? and(baseFilter, eq(workflows.isActive, true))
    : baseFilter;

  const rows = await db
    .select()
    .from(workflows)
    .where(filter)
    .orderBy(asc(workflows.createdAt));

  if (rows.length === 0) return [];

  const workflowIds = rows.map((r) => r.id);

  const [allStates, allTransitions, recordCounts] = await Promise.all([
    db
      .select()
      .from(workflowStates)
      .where(inArray(workflowStates.workflowId, workflowIds))
      .orderBy(asc(workflowStates.sortOrder), asc(workflowStates.id)),
    db
      .select()
      .from(workflowTransitions)
      .where(inArray(workflowTransitions.workflowId, workflowIds))
      .orderBy(asc(workflowTransitions.id)),
    db
      .select({ workflowId: entityInstances.workflowId, total: count() })
      .from(entityInstances)
      .where(inArray(entityInstances.workflowId, workflowIds))
      .groupBy(entityInstances.workflowId),
  ]);

  const countByWorkflow = new Map(
    recordCounts.map((r) => [r.workflowId, r.total]),
  );

  const statesByWorkflow = new Map<string, WorkflowState[]>();
  for (const s of allStates) {
    const mapped = rowToState(s);
    if (!statesByWorkflow.has(mapped.workflowId)) {
      statesByWorkflow.set(mapped.workflowId, []);
    }
    statesByWorkflow.get(mapped.workflowId)?.push(mapped);
  }

  const transitionsByWorkflow = new Map<string, WorkflowTransition[]>();
  for (const t of allTransitions) {
    const mapped = rowToTransition(t);
    if (!transitionsByWorkflow.has(mapped.workflowId)) {
      transitionsByWorkflow.set(mapped.workflowId, []);
    }
    transitionsByWorkflow.get(mapped.workflowId)?.push(mapped);
  }

  return rows.map((row) => ({
    ...rowToWorkflow(row),
    recordCount: countByWorkflow.get(row.id) ?? 0,
    states: statesByWorkflow.get(row.id) ?? [],
    transitions: transitionsByWorkflow.get(row.id) ?? [],
  }));
}

export async function updateWorkflow(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  caller: WorkflowCaller,
  input: UpdateWorkflowInput,
): Promise<WorkflowDefinition> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), visibleTo(tenantId)))
    .limit(1);

  if (row === undefined)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (row.tenantId === null)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (
    !caller.isGlobalAdmin &&
    !isWorkflowAdmin(caller.userId, {
      createdBy: row.createdBy ?? null,
      assignedTo: row.assignedTo ?? [],
    })
  ) {
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  }

  if (
    input.assignedTo !== undefined &&
    !caller.isGlobalAdmin &&
    !isWorkflowAdminListEditor(caller.userId, row)
  ) {
    throw new WorkflowError("WORKFLOW_ADMIN_LIST_FORBIDDEN", { workflowId });
  }
  if (
    input.assignedTo !== undefined &&
    !caller.isGlobalAdmin &&
    row.createdBy &&
    !input.assignedTo.includes(row.createdBy)
  ) {
    throw new WorkflowError("WORKFLOW_ADMIN_REMOVE_CREATOR_FORBIDDEN", {
      workflowId,
    });
  }

  const updates: Partial<typeof workflows.$inferInsert> = {};
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;
  if (input.maxChildDepth !== undefined)
    updates.maxChildDepth = input.maxChildDepth ?? 1;
  if (input.maxChildrenPerParent !== undefined)
    updates.maxChildrenPerParent = input.maxChildrenPerParent ?? 10;

  if (Object.keys(updates).length === 0) {
    const [current] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    if (!current) throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
    return rowToWorkflow(current);
  }

  const [updated] = await db
    .update(workflows)
    .set(updates)
    .where(eq(workflows.id, workflowId))
    .returning();

  if (!updated) throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });

  logger.info(
    { tenantId, workflowId, isActive: updated.isActive },
    "Workflow updated",
  );
  return rowToWorkflow(updated);
}

export async function deleteWorkflow(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  caller: WorkflowCaller,
): Promise<void> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), visibleTo(tenantId)))
    .limit(1);

  // Not found, or is a system workflow (tenant_id = null — read-only)
  if (row === undefined)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (row.tenantId === null)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (!caller.isGlobalAdmin && !isWorkflowAdminListEditor(caller.userId, row)) {
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  }

  // Block deletion if any entity instances are still attached to this workflow
  const [instance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(eq(entityInstances.workflowId, workflowId))
    .limit(1);

  if (instance) {
    throw new WorkflowError("WORKFLOW_HAS_ACTIVE_INSTANCES", { workflowId });
  }

  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowId));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId));
  await db.delete(workflows).where(eq(workflows.id, workflowId));

  logger.info({ tenantId, workflowId }, "Workflow deleted");
}

// ── State CRUD ────────────────────────────────────────────────────────────────

async function assertWorkflowOwned(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  caller: WorkflowCaller,
): Promise<void> {
  const [row] = await db
    .select({
      id: workflows.id,
      createdBy: workflows.createdBy,
      assignedTo: workflows.assignedTo,
    })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)))
    .limit(1);

  if (!row) throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (
    !caller.isGlobalAdmin &&
    !isWorkflowAdmin(caller.userId, {
      createdBy: row.createdBy ?? null,
      assignedTo: row.assignedTo ?? [],
    })
  ) {
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  }
}

export async function addWorkflowState(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  caller: WorkflowCaller,
  input: CreateWorkflowStateInput,
): Promise<WorkflowState> {
  await assertWorkflowOwned(db, tenantId, workflowId, caller);

  const [row] = await db
    .insert(workflowStates)
    .values({
      workflowId,
      name: input.name,
      label: input.label,
      color: input.color,
      isTerminal: input.isTerminal ?? false,
      slaHours: input.slaHours ?? null,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();

  if (!row) throw new WorkflowError("WORKFLOW_STATE_NOT_FOUND");

  logger.info(
    { tenantId, workflowId, stateId: row.id },
    "Workflow state added",
  );
  return rowToState(row);
}

export async function updateWorkflowState(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  stateId: string,
  caller: WorkflowCaller,
  input: UpdateWorkflowStateInput,
): Promise<WorkflowState> {
  await assertWorkflowOwned(db, tenantId, workflowId, caller);

  const [current] = await db
    .select()
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.id, stateId),
        eq(workflowStates.workflowId, workflowId),
      ),
    )
    .limit(1);
  if (!current)
    throw new WorkflowError("WORKFLOW_STATE_NOT_FOUND", { stateId });

  const newName =
    input.name !== undefined && input.name !== current.name
      ? input.name
      : undefined;
  const renaming = newName !== undefined;

  // Renaming a state's internal name requires cascading the change into every
  // workflow_transitions row (fromState/toState), the workflow's initialState,
  // AND every entity_instances row currently sitting in this state — all of
  // those columns store the name string directly, not the state's row id.
  // Missing the entity_instances cascade would leave in-flight tickets with a
  // currentState that no longer matches anything, silently stuck (their
  // currentState would never again equal any transition's fromState).
  if (newName !== undefined) {
    const [duplicate] = await db
      .select({ id: workflowStates.id })
      .from(workflowStates)
      .where(
        and(
          eq(workflowStates.workflowId, workflowId),
          eq(workflowStates.name, newName),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw new WorkflowError("WORKFLOW_STATE_NAME_TAKEN", { name: newName });
    }
  }

  const updates: Partial<typeof workflowStates.$inferInsert> = {};
  if (newName !== undefined) updates.name = newName;
  if (input.label !== undefined) updates.label = input.label;
  if (input.color !== undefined) updates.color = input.color;
  if (input.isTerminal !== undefined) updates.isTerminal = input.isTerminal;
  if (input.slaHours !== undefined) updates.slaHours = input.slaHours;
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

  const [row] = await db
    .update(workflowStates)
    .set(updates)
    .where(
      and(
        eq(workflowStates.id, stateId),
        eq(workflowStates.workflowId, workflowId),
      ),
    )
    .returning();

  if (!row) throw new WorkflowError("WORKFLOW_STATE_NOT_FOUND", { stateId });

  if (renaming) {
    const oldName = current.name;
    const finalName = row.name;
    await db
      .update(workflowTransitions)
      .set({ fromState: finalName })
      .where(
        and(
          eq(workflowTransitions.workflowId, workflowId),
          eq(workflowTransitions.fromState, oldName),
        ),
      );
    await db
      .update(workflowTransitions)
      .set({ toState: finalName })
      .where(
        and(
          eq(workflowTransitions.workflowId, workflowId),
          eq(workflowTransitions.toState, oldName),
        ),
      );
    await db
      .update(workflows)
      .set({ initialState: finalName })
      .where(
        and(eq(workflows.id, workflowId), eq(workflows.initialState, oldName)),
      );
    await db
      .update(entityInstances)
      .set({ currentState: finalName })
      .where(
        and(
          eq(entityInstances.workflowId, workflowId),
          eq(entityInstances.currentState, oldName),
        ),
      );
    logger.info(
      { tenantId, workflowId, stateId, oldName, newName: finalName },
      "Workflow state renamed — cascaded to transitions/initialState/entity_instances",
    );
  }

  logger.info({ tenantId, workflowId, stateId }, "Workflow state updated");
  return rowToState(row);
}

export async function deleteWorkflowState(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  stateId: string,
  caller: WorkflowCaller,
): Promise<void> {
  await assertWorkflowOwned(db, tenantId, workflowId, caller);

  const [state] = await db
    .select({ name: workflowStates.name })
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.id, stateId),
        eq(workflowStates.workflowId, workflowId),
      ),
    )
    .limit(1);

  if (!state) throw new WorkflowError("WORKFLOW_STATE_NOT_FOUND", { stateId });

  // Block if any transition references this state
  const [ref] = await db
    .select({ id: workflowTransitions.id })
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workflowId, workflowId),
        or(
          eq(workflowTransitions.fromState, state.name),
          eq(workflowTransitions.toState, state.name),
        ),
      ),
    )
    .limit(1);

  if (ref) throw new WorkflowError("WORKFLOW_STATE_IN_USE", { stateId });

  await db
    .delete(workflowStates)
    .where(
      and(
        eq(workflowStates.id, stateId),
        eq(workflowStates.workflowId, workflowId),
      ),
    );

  logger.info({ tenantId, workflowId, stateId }, "Workflow state deleted");
}

// ── Transition CRUD ───────────────────────────────────────────────────────────

export async function addWorkflowTransition(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  caller: WorkflowCaller,
  input: CreateWorkflowTransitionInput,
): Promise<WorkflowTransition> {
  await assertWorkflowOwned(db, tenantId, workflowId, caller);

  const [row] = await db
    .insert(workflowTransitions)
    .values({
      workflowId,
      fromState: input.fromState,
      toState: input.toState,
      label: input.label ?? null,
      allowedRoles: input.allowedRoles ?? [],
      conditions: (input.conditions as Record<string, unknown> | null) ?? null,
      requiresComment: input.requiresComment ?? false,
      requiresFields: input.requiresFields ?? [],
    })
    .returning();

  if (!row) throw new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND");

  logger.info(
    { tenantId, workflowId, transitionId: row.id },
    "Workflow transition added",
  );
  return rowToTransition(row);
}

export async function updateWorkflowTransition(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  transitionId: string,
  caller: WorkflowCaller,
  input: UpdateWorkflowTransitionInput,
): Promise<WorkflowTransition> {
  await assertWorkflowOwned(db, tenantId, workflowId, caller);

  const updates: Partial<typeof workflowTransitions.$inferInsert> = {};
  if (input.label !== undefined) updates.label = input.label;
  if (input.allowedRoles !== undefined)
    updates.allowedRoles = input.allowedRoles;
  if (input.conditions !== undefined)
    updates.conditions =
      (input.conditions as Record<string, unknown> | null) ?? null;
  if (input.requiresComment !== undefined)
    updates.requiresComment = input.requiresComment;
  if (input.requiresFields !== undefined)
    updates.requiresFields = input.requiresFields;

  const [row] = await db
    .update(workflowTransitions)
    .set(updates)
    .where(
      and(
        eq(workflowTransitions.id, transitionId),
        eq(workflowTransitions.workflowId, workflowId),
      ),
    )
    .returning();

  if (!row)
    throw new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND", { transitionId });

  logger.info(
    { tenantId, workflowId, transitionId },
    "Workflow transition updated",
  );
  return rowToTransition(row);
}

export async function deleteWorkflowTransition(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  transitionId: string,
  caller: WorkflowCaller,
): Promise<void> {
  await assertWorkflowOwned(db, tenantId, workflowId, caller);

  const [row] = await db
    .delete(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.id, transitionId),
        eq(workflowTransitions.workflowId, workflowId),
      ),
    )
    .returning({ id: workflowTransitions.id });

  if (!row)
    throw new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND", { transitionId });

  logger.info(
    { tenantId, workflowId, transitionId },
    "Workflow transition deleted",
  );
}
