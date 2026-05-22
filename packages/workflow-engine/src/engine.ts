import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";
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
  // 1. Load entity instance with a pessimistic write lock.
  // FOR UPDATE NOWAIT throws Postgres error 55P03 immediately if another transaction
  // already holds the lock — the caller gets TRANSITION_LOCKED and retries after the
  // Retry-After header interval.
  //
  // Combining the read and the lock into a single query closes the TOCTOU window that
  // would exist between a plain SELECT (reading current_state) and a separate
  // FOR UPDATE NOWAIT statement. A concurrent transition committing between those two
  // statements would cause the guard at step 3 to compare against a stale current_state,
  // potentially allowing an invalid state-machine transition.
  let instance: typeof entityInstances.$inferSelect | undefined;
  try {
    [instance] = await db
      .select()
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.id, request.instanceId),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .for("update", { noWait: true })
      .limit(1);
  } catch (err) {
    const code =
      (err as { code?: unknown }).code ??
      (err as { cause?: { code?: unknown } }).cause?.code;
    if (code === "55P03") {
      throw new WorkflowError("TRANSITION_LOCKED", {
        instanceId: request.instanceId,
      });
    }
    throw err;
  }

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

  // 1d. Idempotency check — return existing event if key already used
  if (request.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.instanceId, request.instanceId),
          eq(workflowEvents.idempotencyKey, request.idempotencyKey),
          isNotNull(workflowEvents.idempotencyKey),
        ),
      )
      .limit(1);

    if (existing) {
      return {
        id: existing.id,
        instanceId: existing.instanceId,
        workflowId: existing.workflowId,
        fromState: existing.fromState ?? null,
        toState: existing.toState,
        triggeredBy: existing.triggeredBy as WorkflowEvent["triggeredBy"],
        actorId: existing.actorId ?? null,
        comment: existing.comment ?? null,
        metadata: (existing.metadata ?? {}) as Record<string, unknown>,
        createdAt: existing.createdAt,
      };
    }
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

  if (transition?.fromState !== instance.currentState) {
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
  //
  // Transitions are irreversible by design (ADR-002 WE-02). workflow_events is an
  // append-only audit log. If a rollback path is needed, define an explicit reverse
  // transition in the workflow definition — do not attempt to mutate past events.
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
      tenantId,
      instanceId: request.instanceId,
      workflowId: instance.workflowId,
      fromState: instance.currentState,
      toState: transition.toState,
      triggeredBy,
      actorId: request.actorId ?? null,
      comment: request.comment ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
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

  // Cancel any pending SLA timers for the state we are leaving.
  // Marks undelivered workflow.sla_scheduled outbox events as delivered so the
  // SLA scheduler does not enqueue a breach job.  Already-enqueued jobs are
  // guarded by the breacher which checks current_state before writing the breach
  // event.
  //
  // Ordering note: cancellation runs after the workflow.transitioned outbox
  // write above.  Both are inside the caller's transaction so ordering within
  // the transaction is harmless — either both commit or both roll back.
  await cancelPendingSlaTimers(
    db,
    tenantId,
    request.instanceId,
    instance.currentState,
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
    metadata: (eventRow.metadata ?? {}) as Record<string, unknown>,
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

  if (!instance?.workflowId) return [];

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
    metadata: (e.metadata ?? {}) as Record<string, unknown>,
    createdAt: e.createdAt,
  }));
}

// ── SLA helpers ───────────────────────────────────────────────────────────────

/**
 * Marks undelivered `workflow.sla_scheduled` outbox events for a specific
 * instance + state as delivered, preventing the SLA scheduler from enqueuing
 * breach jobs for the state being left.  Must be called within the same
 * transaction as the state update.
 */
async function cancelPendingSlaTimers(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  stateName: string,
): Promise<void> {
  await db
    .update(outboxEvents)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(outboxEvents.tenantId, tenantId),
        eq(outboxEvents.eventType, "workflow.sla_scheduled"),
        isNull(outboxEvents.deliveredAt),
        sql`${outboxEvents.payload}->>'instanceId' = ${instanceId}`,
        sql`${outboxEvents.payload}->>'stateName' = ${stateName}`,
      ),
    );
}

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
