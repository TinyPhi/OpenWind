import { randomUUID } from "node:crypto";
import { eq, and, or, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityInstances,
  entityFields,
  workflows,
  workflowTransitions,
  workflowStates,
  workflowEvents,
  outboxEvents,
} from "@platform/db";
import { redactMetadata, buildSensitivityMap } from "./redact.js";
import { logger } from "@platform/logger";
import { WorkflowError } from "./errors.js";
import {
  evaluateConditionTree,
  treeNeedsPriorActors,
} from "./condition-evaluator.js";
import type {
  WorkflowTransition,
  WorkflowEvent,
  TransitionRequest,
  WorkflowTransitionedEvent,
  ActorContext,
  TransitionConditionTree,
  StateOverrideRequest,
} from "./types.js";
import {
  OVERRIDE_REASON_MIN_LENGTH,
  OVERRIDE_REASON_MAX_LENGTH,
} from "./types.js";

/**
 * Only a real user can satisfy an actor rule. An API key's identity ("apikey:<id>") is minted
 * per key, so it is never the creator and never appears in earlier history: letting it through
 * would let a record's creator approve their own work by acting through a key (and rotating
 * the key would reset "already acted"). Automation and system carry no user either.
 */
function userActorId(actorId: string | null | undefined): string | null {
  if (actorId === null || actorId === undefined || actorId === "") return null;
  if (actorId === "system" || actorId.startsWith("apikey:")) return null;
  return actorId;
}

/**
 * What the actor rules are evaluated against. The creator comes from the instance row already
 * in hand; the prior actors are read from the event log only when a tree actually needs them,
 * so a workflow with no segregation rule pays nothing. In executeTransition this runs inside
 * the row lock, so the history it reads cannot change under the decision.
 *
 * "Acted" means a real state change: from_state differs from to_state. Comments, tags, severity
 * and attachment events, and access grants all record the current state as both, and that is
 * set by the server, unlike metadata, which a caller can write (a transition sent with
 * metadata {"type":"comment"} must still count).
 */
async function loadActorContext(
  db: DbOrTx,
  tenantId: string,
  instance: { id: string; createdBy: string | null },
  actorId: string | null | undefined,
  trees: ReadonlyArray<TransitionConditionTree | null>,
): Promise<ActorContext> {
  const context: ActorContext = {
    actorId: userActorId(actorId),
    createdBy: instance.createdBy,
  };
  if (!trees.some(treeNeedsPriorActors)) return context;

  const rows = await db
    .selectDistinct({
      actorId: workflowEvents.actorId,
      fromState: workflowEvents.fromState,
    })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.instanceId, instance.id),
        eq(workflowEvents.tenantId, tenantId),
        isNotNull(workflowEvents.actorId),
        isNotNull(workflowEvents.fromState),
        sql`${workflowEvents.fromState} <> ${workflowEvents.toState}`,
      ),
    );
  const priorActors: Array<{ actorId: string; fromState: string }> = [];
  for (const r of rows) {
    const id = userActorId(r.actorId);
    if (id !== null && r.fromState !== null) {
      priorActors.push({ actorId: id, fromState: r.fromState });
    }
  }
  return { ...context, priorActors };
}

/** A locked entity instance that is attached to a workflow. */
type LockedInstance = typeof entityInstances.$inferSelect & {
  workflowId: string;
};

/**
 * Loads an entity instance with a pessimistic write lock, in one statement.
 * FOR UPDATE NOWAIT throws Postgres error 55P03 immediately if another transaction already
 * holds the lock: the caller gets TRANSITION_LOCKED and retries after the Retry-After interval.
 *
 * Combining the read and the lock into a single query closes the TOCTOU window that would
 * exist between a plain SELECT (reading current_state) and a separate FOR UPDATE NOWAIT
 * statement: a concurrent change committing between those two would let a guard compare
 * against a stale current_state. Shared by executeTransition and overrideWorkflowState.
 */
async function lockInstance(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<LockedInstance> {
  let instance: typeof entityInstances.$inferSelect | undefined;
  try {
    [instance] = await db
      .select()
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.id, instanceId),
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
        instanceId,
      });
    }
    throw err;
  }

  if (!instance) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      instanceId,
    });
  }

  if (!instance.workflowId) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      instanceId,
      reason: "no workflow attached",
    });
  }

  return { ...instance, workflowId: instance.workflowId };
}

interface StateChange {
  toState: string;
  triggeredBy: WorkflowEvent["triggeredBy"];
  actorId?: string | undefined;
  comment?: string | undefined;
  idempotencyKey?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  depth?: number | undefined;
  transitionEventId: string;
  /** Marks the outbox event as an override rather than a guarded transition. */
  override?: true | undefined;
}

/**
 * The write half of a state change, shared by executeTransition and overrideWorkflowState so
 * the two cannot drift: update the state, append the event (redacting sensitive metadata at
 * INSERT time), write the outbox event, cancel the SLA timers of the state being left and
 * schedule the one being entered. Everything runs in the caller's transaction and the caller
 * must already hold the instance lock.
 */
async function commitStateChange(
  db: DbOrTx,
  tenantId: string,
  instance: LockedInstance,
  change: StateChange,
): Promise<WorkflowEvent> {
  const { transitionEventId, triggeredBy } = change;
  const occurredAt = new Date();

  // 8–9. Update state + append event + write outbox — all in the caller's transaction
  // (caller wraps in withTenantContext which provides a transaction)
  //
  // Transitions are irreversible by design (ADR-002 WE-02). workflow_events is an
  // append-only audit log. If a rollback path is needed, define an explicit reverse
  // transition in the workflow definition — do not attempt to mutate past events.
  await db
    .update(entityInstances)
    .set({ currentState: change.toState, updatedAt: occurredAt })
    .where(
      and(
        eq(entityInstances.id, instance.id),
        eq(entityInstances.tenantId, tenantId),
      ),
    );

  // Redact PII/financial field values from metadata before persisting.
  // workflow_events is an immutable audit log — redaction must happen here,
  // at INSERT time.  Retroactive masking is not permitted (append-only table).
  //
  // We load the field sensitivity map for this entity type.  On most
  // transitions the map will be empty (no pii/financial fields), making the
  // redactMetadata call a cheap no-op.  On sensitive entity types (HRMS,
  // health records) the map will contain a small number of entries.
  const rawMetadata = change.metadata ?? {};
  let safeMetadata: Record<string, unknown> = rawMetadata;

  if (Object.keys(rawMetadata).length > 0) {
    const fieldRows = await db
      .select({
        name: entityFields.name,
        sensitivity: entityFields.sensitivity,
      })
      .from(entityFields)
      .where(
        and(
          eq(entityFields.entityTypeId, instance.entityTypeId),
          // Explicit tenantId guard — consistent with all other tenant-scoped
          // queries in this codebase; also safe in contexts where RLS is off.
          // System fields (tenantId IS NULL) are included via the OR.
          or(
            isNull(entityFields.tenantId),
            eq(entityFields.tenantId, tenantId),
          ),
        ),
      );

    const sensitivityMap = buildSensitivityMap(
      fieldRows.map((r) => ({
        name: r.name,
        // Drizzle types text columns as string; the CHECK constraint on
        // entity_fields.sensitivity guarantees the value is always one of
        // the four valid FieldSensitivity literals at the DB level.
        sensitivity: r.sensitivity as
          | "public"
          | "internal"
          | "pii"
          | "financial",
      })),
    );

    safeMetadata = redactMetadata(rawMetadata, sensitivityMap);
  }

  const [eventRow] = await db
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId: instance.id,
      workflowId: instance.workflowId,
      fromState: instance.currentState,
      toState: change.toState,
      triggeredBy,
      actorId: change.actorId ?? null,
      comment: change.comment ?? null,
      idempotencyKey: change.idempotencyKey ?? null,
      metadata: safeMetadata,
    })
    .returning();

  if (!eventRow) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      reason: "event insert failed",
    });
  }

  // 10. Write outbox event (same transaction — outbox pattern), unconditionally
  // for every triggeredBy. Previously skipped when triggeredBy === "automation"
  // to avoid double-firing rules via both the in-process recursive call
  // (packages/automation-engine/src/actions/transition.ts) and the async
  // worker path (#120) — but that also meant automation-triggered transitions
  // never reached the outbox at all, silently missing every other outbox
  // consumer (e.g. Phase 3A connector delivery, ADR-009 Decision #3). Dedup
  // now lives in the consumer (packages/automation-engine/src/executor.ts),
  // keyed on transitionEventId — see
  // docs/specs/outbox-automation-idempotent-consumption.md.
  const outboxPayload: WorkflowTransitionedEvent = {
    eventType: "workflow.transitioned",
    version: 1,
    tenantId,
    instanceId: instance.id,
    entityTypeId: instance.entityTypeId,
    workflowId: instance.workflowId,
    fromState: instance.currentState,
    toState: change.toState,
    triggeredBy,
    actorId: change.actorId ?? null,
    occurredAt: occurredAt.toISOString(),
    transitionEventId,
    ...(change.depth !== undefined && { depth: change.depth }),
    ...(change.override === true && { override: true as const }),
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
      instanceId: instance.id,
      fromState: instance.currentState,
      toState: change.toState,
      actorId: change.actorId,
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
    instance.id,
    instance.currentState,
  );

  // Handle SLA for new state
  await scheduleSlaIfNeeded(
    db,
    tenantId,
    instance.workflowId,
    instance.id,
    change.toState,
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
    // Drizzle infers this text() column as string | null, not the narrower
    // union — migration 0091's CHECK constraint guarantees only these two
    // values (or null) are ever stored, so the type system can't infer it
    // but the DB does enforce it.
    originMechanism: (eventRow.originMechanism ?? null) as
      | "api"
      | "handoff"
      | null,
    originOidcClientId: eventRow.originOidcClientId ?? null,
    originPerformerUserId: eventRow.originPerformerUserId ?? null,
    transitionEventId,
  };
}

export async function executeTransition(
  db: DbOrTx,
  tenantId: string,
  request: TransitionRequest,
): Promise<WorkflowEvent> {
  // Identity of this call, not this row — generated unconditionally so both
  // the outbox payload (below) and the return value always carry it. See
  // WorkflowEvent.transitionEventId and issue #143.
  const transitionEventId = randomUUID();

  // 1a. Idempotency check (read-only) — short-circuit before acquiring the write lock.
  // Most duplicate submissions hit this path and never contend on the row lock.
  if (request.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.tenantId, tenantId),
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
        // Drizzle infers this text() column as string | null, not the
        // narrower union — migration 0091's CHECK constraint guarantees only
        // these two values (or null) are ever stored, so the type system
        // can't infer it but the DB does enforce it.
        originMechanism: (existing.originMechanism ?? null) as
          | "api"
          | "handoff"
          | null,
        originOidcClientId: existing.originOidcClientId ?? null,
        originPerformerUserId: existing.originPerformerUserId ?? null,
        // No new outbox row is written on this replay path, so this value
        // is inert — nothing ever reads it off an outbox event for this call.
        transitionEventId,
      };
    }
  }

  // 1b. Load entity instance with a pessimistic write lock (see lockInstance).
  const instance = await lockInstance(db, tenantId, request.instanceId);

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
        eq(workflowTransitions.tenantId, tenantId),
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

  // 5. Guard: conditions (including the segregation-of-duties rules, evaluated against the
  // actor context loaded under this transaction's row lock)
  const fields = instance.fields as Record<string, unknown>;
  const conditions = transition.conditions as TransitionConditionTree | null;
  const actorContext = await loadActorContext(
    db,
    tenantId,
    instance,
    request.actorId,
    [conditions],
  );
  if (!evaluateConditionTree(conditions, fields, actorContext)) {
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

  return commitStateChange(db, tenantId, instance, {
    toState: transition.toState,
    triggeredBy: request.triggeredBy ?? "user",
    actorId: request.actorId,
    comment: request.comment,
    idempotencyKey: request.idempotencyKey,
    metadata: request.metadata,
    depth: request.depth,
    transitionEventId,
  });
}

/**
 * Moves a record to a chosen step outside the transition rules: the recorded, reasoned
 * override (docs/specs/state-override.md). It is the one sanctioned way to fix a record that
 * the workflow's own transitions cannot (ADR-002 WE-02 makes transitions irreversible), and it
 * is deliberately narrow:
 *   - only an admin user, never an API key, system or automation;
 *   - only on a workflow that has switched `allow_state_override` on (off by default);
 *   - never by the person who created the record;
 *   - a reason of OVERRIDE_REASON_MIN_LENGTH..OVERRIDE_REASON_MAX_LENGTH characters;
 *   - the target must be a real step, and different from the current one.
 * It then behaves like a transition in every way that matters: it locks the row, writes the
 * event (a real state change, so it counts as acting for segregation rules), writes the outbox
 * event (flagged `override`) and moves the SLA timers. The admin audit entry is written by the
 * caller in the same transaction, since this package cannot depend on @platform/audit.
 */
export async function overrideWorkflowState(
  db: DbOrTx,
  tenantId: string,
  request: StateOverrideRequest,
): Promise<WorkflowEvent> {
  const actorId = userActorId(request.actorId);
  if (actorId === null || !request.actorRoles.includes("admin")) {
    throw new WorkflowError("OVERRIDE_FORBIDDEN", {
      reason: "an admin user is required",
    });
  }

  const reason = request.reason.trim();
  if (
    reason.length < OVERRIDE_REASON_MIN_LENGTH ||
    reason.length > OVERRIDE_REASON_MAX_LENGTH
  ) {
    throw new WorkflowError("OVERRIDE_REASON_REQUIRED", {
      min: OVERRIDE_REASON_MIN_LENGTH,
      max: OVERRIDE_REASON_MAX_LENGTH,
    });
  }

  const instance = await lockInstance(db, tenantId, request.instanceId);

  const [workflow] = await db
    .select({ allowStateOverride: workflows.allowStateOverride })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, instance.workflowId),
        or(isNull(workflows.tenantId), eq(workflows.tenantId, tenantId)),
      ),
    )
    .limit(1);
  if (!workflow) {
    throw new WorkflowError("INSTANCE_NOT_FOUND", {
      workflowId: instance.workflowId,
    });
  }
  if (!workflow.allowStateOverride) {
    throw new WorkflowError("OVERRIDE_NOT_ENABLED", {
      workflowId: instance.workflowId,
    });
  }

  if (instance.createdBy !== null && instance.createdBy === actorId) {
    throw new WorkflowError("OVERRIDE_FORBIDDEN", {
      reason: "the creator of a record cannot override its state",
    });
  }

  const states = await db
    .select({ name: workflowStates.name })
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.workflowId, instance.workflowId),
        eq(workflowStates.tenantId, tenantId),
      ),
    );
  if (!states.some((st) => st.name === request.state)) {
    throw new WorkflowError("WORKFLOW_STATE_NOT_FOUND", {
      name: request.state,
    });
  }
  if (request.state === instance.currentState) {
    throw new WorkflowError("OVERRIDE_NO_CHANGE", { state: request.state });
  }

  return commitStateChange(db, tenantId, instance, {
    toState: request.state,
    triggeredBy: "user",
    actorId,
    comment: `Override: ${reason}`,
    metadata: { kind: "override", reason },
    transitionEventId: randomUUID(),
    override: true,
  });
}

export async function getAvailableTransitions(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  actorRoles: string[] = [],
  actorId?: string | null,
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
        eq(workflowTransitions.tenantId, tenantId),
      ),
    );

  const fields = instance.fields as Record<string, unknown>;
  // Same context as executeTransition, so this list never offers a transition that the
  // segregation rules would then refuse.
  const actorContext = await loadActorContext(
    db,
    tenantId,
    instance,
    actorId,
    transitions.map((t) => t.conditions as TransitionConditionTree | null),
  );

  return transitions
    .filter((t) => {
      if (
        t.allowedRoles.length > 0 &&
        !hasRequiredRole(actorRoles, t.allowedRoles)
      )
        return false;
      if (
        !evaluateConditionTree(
          t.conditions as TransitionConditionTree | null,
          fields,
          actorContext,
        )
      )
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
      conditions: t.conditions as TransitionConditionTree | null,
      requiresComment: t.requiresComment,
      requiresFields: t.requiresFields,
      sortOrder: t.sortOrder,
    }));
}

// `mentionIdentifiers` maps a user id to the login names/emails third parties
// typed for them. Per-user erasure reads it (apps/api user-erasure.ts); no
// event-log reader may return it, since callers with ticket access include
// customers and the map would hand them identifiers of people they can't see.
function withoutInternalMetadata(metadata: unknown): Record<string, unknown> {
  // jsonb column: the shape is what the writers store, an object or null
  const { mentionIdentifiers: _internal, ...rest } = (metadata ?? {}) as Record<
    string,
    unknown
  >;
  return rest;
}

export async function getWorkflowEventLog(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  opts?: { eventType?: "comment" | "history"; limit?: number },
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

  const typeFilter =
    opts?.eventType === "comment"
      ? sql`${workflowEvents.metadata}->>'type' = 'comment'`
      : opts?.eventType === "history"
        ? sql`(${workflowEvents.metadata}->>'type' IS NULL OR ${workflowEvents.metadata}->>'type' != 'comment')`
        : undefined;

  const baseWhere = typeFilter
    ? and(eq(workflowEvents.instanceId, instanceId), typeFilter)
    : eq(workflowEvents.instanceId, instanceId);

  const query = db
    .select()
    .from(workflowEvents)
    .where(baseWhere)
    .orderBy(workflowEvents.createdAt);

  const events = opts?.limit ? await query.limit(opts.limit) : await query;

  return events.map((e) => ({
    id: e.id,
    instanceId: e.instanceId,
    workflowId: e.workflowId,
    fromState: e.fromState ?? null,
    toState: e.toState,
    triggeredBy: e.triggeredBy as WorkflowEvent["triggeredBy"],
    actorId: e.actorId ?? null,
    comment: e.comment ?? null,
    metadata: withoutInternalMetadata(e.metadata),
    createdAt: e.createdAt,
    triggeredAt: e.createdAt.toISOString(),
    // Drizzle infers this text() column as string | null, not the narrower
    // union — migration 0091's CHECK constraint guarantees only these two
    // values (or null) are ever stored, so the type system can't infer it
    // but the DB does enforce it.
    originMechanism: (e.originMechanism ?? null) as "api" | "handoff" | null,
    originOidcClientId: e.originOidcClientId ?? null,
    originPerformerUserId: e.originPerformerUserId ?? null,
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
        eq(workflowStates.tenantId, tenantId),
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
