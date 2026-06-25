import { eq, and, or, isNull, asc, inArray, count } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  workflows,
  workflowStates,
  workflowTransitions,
  entityInstances,
} from "@platform/db";
import { logger } from "@platform/logger";
import { WorkflowError } from "./errors.js";
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
    assignedTo: r.assignedTo as string | null,
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

// ── Workflow CRUD ─────────────────────────────────────────────────────────────

export async function createWorkflow(
  db: DbOrTx,
  tenantId: string,
  input: CreateWorkflowInput,
): Promise<WorkflowDefinition> {
  const [row] = await db
    .insert(workflows)
    .values({
      tenantId,
      entityTypeId: input.entityTypeId,
      name: input.name,
      initialState: input.initialState,
    })
    .returning();

  if (!row) throw new WorkflowError("WORKFLOW_NOT_FOUND");

  logger.info({ tenantId, workflowId: row.id }, "Workflow created");
  return rowToWorkflow(row);
}

export async function getWorkflow(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
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

export async function listWorkflows(
  db: DbOrTx,
  tenantId: string,
  entityTypeId?: string,
  activeOnly?: boolean,
): Promise<WorkflowFull[]> {
  const baseFilter = entityTypeId
    ? and(eq(workflows.entityTypeId, entityTypeId), visibleTo(tenantId))
    : visibleTo(tenantId);
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
  input: UpdateWorkflowInput,
): Promise<WorkflowDefinition> {
  const [row] = await db
    .select({ id: workflows.id, tenantId: workflows.tenantId })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), visibleTo(tenantId)))
    .limit(1);

  if (row === undefined)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (row.tenantId === null)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });

  const updates: Partial<typeof workflows.$inferInsert> = {};
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;

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
): Promise<void> {
  const [row] = await db
    .select({ id: workflows.id, tenantId: workflows.tenantId })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), visibleTo(tenantId)))
    .limit(1);

  // Not found, or is a system workflow (tenant_id = null — read-only)
  if (row === undefined)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
  if (row.tenantId === null)
    throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });

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
): Promise<void> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)))
    .limit(1);

  if (!row) throw new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId });
}

export async function addWorkflowState(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  input: CreateWorkflowStateInput,
): Promise<WorkflowState> {
  await assertWorkflowOwned(db, tenantId, workflowId);

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
  input: UpdateWorkflowStateInput,
): Promise<WorkflowState> {
  await assertWorkflowOwned(db, tenantId, workflowId);

  const updates: Partial<typeof workflowStates.$inferInsert> = {};
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

  logger.info({ tenantId, workflowId, stateId }, "Workflow state updated");
  return rowToState(row);
}

export async function deleteWorkflowState(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  stateId: string,
): Promise<void> {
  await assertWorkflowOwned(db, tenantId, workflowId);

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
  input: CreateWorkflowTransitionInput,
): Promise<WorkflowTransition> {
  await assertWorkflowOwned(db, tenantId, workflowId);

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
  input: UpdateWorkflowTransitionInput,
): Promise<WorkflowTransition> {
  await assertWorkflowOwned(db, tenantId, workflowId);

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
): Promise<void> {
  await assertWorkflowOwned(db, tenantId, workflowId);

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
