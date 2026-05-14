import { eq, and } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityInstances,
  workflows,
  workflowTransitions,
  workflowStates,
  workflowEvents,
  outboxEvents,
} from "@platform/db";
import { logger } from "@platform/logger";
import { WorkflowError } from "./errors.js";
import { evaluateConditionTree } from "./condition-evaluator.js";
import type {
  WorkflowTransition,
  WorkflowEvent,
  TransitionRequest,
  WorkflowTransitionedEvent,
  ConditionTree,
} from "./types.js";

export async function executeTransition(
  db: DbOrTx,
  tenantId: string,
  request: TransitionRequest,
): Promise<WorkflowEvent> {
  // 1. Load entity instance
  const [instance] = await db
    .select()
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, request.instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!instance) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      instanceId: request.instanceId,
    });
  }

  if (!instance.workflowId) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      instanceId: request.instanceId,
      reason: "no workflow attached",
    });
  }

  // 2. Load workflow definition
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, instance.workflowId))
    .limit(1);

  if (!workflow) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      workflowId: instance.workflowId,
    });
  }

  // 3. Find matching transition
  const [transition] = await db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workflowId, instance.workflowId),
        eq(workflowTransitions.id, request.transitionId),
      ),
    )
    .limit(1);

  if (!transition || transition.fromState !== instance.currentState) {
    throw new WorkflowError("TRANSITION_NOT_AVAILABLE", {
      instanceId: request.instanceId,
      currentState: instance.currentState,
      transitionId: request.transitionId,
    });
  }

  // 4. Guard: allowed roles
  if (
    transition.allowedRoles.length > 0 &&
    !hasRequiredRole(request.actorRoles ?? [], transition.allowedRoles)
  ) {
    throw new WorkflowError("TRANSITION_FORBIDDEN", {
      actorRoles: request.actorRoles,
      allowedRoles: transition.allowedRoles,
    });
  }

  // 5. Guard: conditions
  const fields = instance.fields as Record<string, unknown>;
  if (
    !evaluateConditionTree(
      transition.conditions as ConditionTree | null,
      fields,
    )
  ) {
    throw new WorkflowError("CONDITION_NOT_MET", {
      transitionId: transition.id,
    });
  }

  // 6. Guard: requires_fields
  if (transition.requiresFields.length > 0) {
    const missing = transition.requiresFields.filter(
      (f) => fields[f] === null || fields[f] === undefined || fields[f] === "",
    );
    if (missing.length > 0) {
      throw new WorkflowError("REQUIRED_FIELDS_MISSING", { missing });
    }
  }

  // 7. Guard: requires_comment
  if (transition.requiresComment && !request.comment?.trim()) {
    throw new WorkflowError("REQUIRED_FIELDS_MISSING", {
      missing: ["comment"],
    });
  }

  const triggeredBy = request.triggeredBy ?? "user";
  const occurredAt = new Date();

  // 8–9. Update state + append event + write outbox — all in the caller's transaction
  // (caller wraps in withTenantContext which provides a transaction)
  await db
    .update(entityInstances)
    .set({ currentState: transition.toState, updatedAt: occurredAt })
    .where(
      and(
        eq(entityInstances.id, request.instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    );

  const [eventRow] = await db
    .insert(workflowEvents)
    .values({
      instanceId: request.instanceId,
      workflowId: instance.workflowId,
      fromState: instance.currentState,
      toState: transition.toState,
      triggeredBy,
      actorId: request.actorId ?? null,
      comment: request.comment ?? null,
      metadata: request.metadata ?? {},
    })
    .returning();

  if (!eventRow) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      reason: "event insert failed",
    });
  }

  // 10. Write outbox event (same transaction — outbox pattern)
  const outboxPayload: WorkflowTransitionedEvent = {
    eventType: "workflow.transitioned",
    version: 1,
    tenantId,
    instanceId: request.instanceId,
    entityTypeId: instance.entityTypeId,
    workflowId: instance.workflowId,
    fromState: instance.currentState,
    toState: transition.toState,
    triggeredBy,
    actorId: request.actorId ?? null,
    occurredAt: occurredAt.toISOString(),
  };

  await db.insert(outboxEvents).values({
    tenantId,
    eventType: "workflow.transitioned",
    version: 1,
    payload: outboxPayload,
  });

  logger.info(
    {
      tenantId,
      instanceId: request.instanceId,
      fromState: instance.currentState,
      toState: transition.toState,
      actorId: request.actorId,
      triggeredBy,
    },
    "Transition executed",
  );

  // Handle SLA for new state
  await scheduleSlaIfNeeded(
    db,
    tenantId,
    instance.workflowId,
    request.instanceId,
    transition.toState,
    occurredAt,
  );

  return {
    id: eventRow.id,
    instanceId: eventRow.instanceId,
    workflowId: eventRow.workflowId,
    fromState: eventRow.fromState ?? null,
    toState: eventRow.toState,
    triggeredBy: eventRow.triggeredBy as WorkflowEvent["triggeredBy"],
    actorId: eventRow.actorId ?? null,
    comment: eventRow.comment ?? null,
    metadata: (eventRow.metadata as Record<string, unknown>) ?? {},
    createdAt: eventRow.createdAt,
  };
}

export async function getAvailableTransitions(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  actorRoles: string[] = [],
): Promise<WorkflowTransition[]> {
  const [instance] = await db
    .select()
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!instance || !instance.workflowId) return [];

  const transitions = await db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workflowId, instance.workflowId),
        eq(workflowTransitions.fromState, instance.currentState),
      ),
    );

  const fields = instance.fields as Record<string, unknown>;

  return transitions
    .filter((t) => {
      if (
        t.allowedRoles.length > 0 &&
        !hasRequiredRole(actorRoles, t.allowedRoles)
      )
        return false;
      if (!evaluateConditionTree(t.conditions as ConditionTree | null, fields))
        return false;
      return true;
    })
    .map((t) => ({
      id: t.id,
      workflowId: t.workflowId,
      fromState: t.fromState,
      toState: t.toState,
      label: t.label ?? null,
      allowedRoles: t.allowedRoles,
      conditions: t.conditions as ConditionTree | null,
      requiresComment: t.requiresComment,
      requiresFields: t.requiresFields,
    }));
}

export async function getWorkflowEventLog(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<WorkflowEvent[]> {
  // RLS enforces tenantId — but verify the instance belongs to this tenant first
  const [instance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!instance) return [];

  const events = await db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.instanceId, instanceId))
    .orderBy(workflowEvents.createdAt);

  return events.map((e) => ({
    id: e.id,
    instanceId: e.instanceId,
    workflowId: e.workflowId,
    fromState: e.fromState ?? null,
    toState: e.toState,
    triggeredBy: e.triggeredBy as WorkflowEvent["triggeredBy"],
    actorId: e.actorId ?? null,
    comment: e.comment ?? null,
    metadata: (e.metadata as Record<string, unknown>) ?? {},
    createdAt: e.createdAt,
  }));
}

// ── SLA helpers ───────────────────────────────────────────────────────────────

async function scheduleSlaIfNeeded(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  instanceId: string,
  stateName: string,
  enteredAt: Date,
): Promise<void> {
  const [state] = await db
    .select()
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.workflowId, workflowId),
        eq(workflowStates.name, stateName),
      ),
    )
    .limit(1);

  if (!state?.slaHours) return;

  // Write an SLA-scheduled outbox event; the worker will enqueue the BullMQ job
  const fireAt = new Date(
    enteredAt.getTime() + state.slaHours * 60 * 60 * 1000,
  );

  await db.insert(outboxEvents).values({
    tenantId,
    eventType: "workflow.sla_scheduled",
    version: 1,
    payload: {
      instanceId,
      workflowId,
      stateName,
      slaHours: state.slaHours,
      fireAt: fireAt.toISOString(),
    },
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function hasRequiredRole(
  actorRoles: string[],
  allowedRoles: string[],
): boolean {
  return actorRoles.some((r) => allowedRoles.includes(r));
}
