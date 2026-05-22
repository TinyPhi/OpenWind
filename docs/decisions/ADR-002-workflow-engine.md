# ADR-002: Workflow Engine State Machine Design

**Status:** Accepted  
**Date:** 2025-05  
**Deciders:** Engineering lead, Platform architect  
**Supersedes:** —  
**Superseded by:** —

---

## Context

The Workflow Engine is the intellectual center of the platform. Every operational process a customer runs — support tickets, expense approvals, sales deals, vendor onboarding, leave requests, procurement cycles — is modeled as an entity moving through a workflow. The design of the state machine determines:

- What kinds of processes the platform can represent
- How easy it is for customers to configure those processes
- How reliably state transitions execute (atomicity, idempotency)
- How completely and queryably history is recorded
- Whether the engine can be extended without breaking existing workflows

The design space is large. We need to choose a specific model and commit to it. Wrong choices here propagate into every module, every customer workflow, and every automation rule.

### What the engine must handle

Drawing from a survey of actual customer processes:

1. **Linear workflows:** Draft → Submitted → Approved → Paid. Most workflows are essentially this.
2. **Branching workflows:** An expense can be Approved or Rejected from the Review state. A deal can be Won or Lost from Negotiation.
3. **Conditional transitions:** A transition is only available if certain conditions are true (e.g., `amount > 50000` routes to Finance Review, not directly to Approval).
4. **Role-gated transitions:** Only a Finance Manager can approve an expense. Only the ticket assignee can mark it resolved.
5. **SLA-driven transitions:** If a ticket has not moved from Escalated within 4 hours, auto-transition to Critical.
6. **Parallel approval:** A contract must be approved by both Legal and Finance before it can proceed.
7. **Optional actions that don't change state:** Adding a comment, attaching a file, logging a call. These should be recorded but should not be modeled as state changes.
8. **Re-open transitions:** A resolved ticket can be re-opened. A rejected expense can be re-submitted. These are just transitions — there is no special status.
9. **Audit trail requirement:** Every state change, who made it, when, and under what conditions, must be permanently and immutably recorded.

### What the engine explicitly does not need to handle (right now)

- **Sub-workflows / nested processes:** A ticket does not have internal stages within a stage. If this need arises, it is modeled as a related entity with its own workflow.
- **Forking parallel paths on the same entity:** An entity cannot be in two states simultaneously. Parallel approval is handled via related approval entities (see below), not by the main entity being in multiple states.
- **Long-running saga coordination:** Multi-system transactions spanning hours or days (e.g., provision cloud resources, wait for DNS, configure SSL, send email) are handled by the iPaaS bridge (Trigger.dev), not this engine.
- **Dynamic workflow modification mid-execution:** The workflow definition does not change while instances are active on it. New workflow versions apply to new instances only.

---

## Evaluated Options

### Option 1: Code-based state machine using XState

XState is a mature JavaScript library for modeling state machines and statecharts. Workflows are defined as XState machine configurations in TypeScript.

**How it works:** Each workflow is an XState machine. When a transition is requested, XState computes the next state, guards are evaluated by XState's guard system, and side effects are handled by XState services. The machine definition is stored as JSON in the database and hydrated at runtime.

**Advantages:**

- Extremely powerful. XState supports parallel states, history states, nested states, deferred events, and actors.
- Type-safe machine definitions.
- XState's developer tooling (visualizer, inspector) is excellent.
- Well-tested library with a large community.

**Disadvantages:**

- Significant accidental complexity. XState is designed for UI state management and complex statecharts. Business workflows do not need parallel states, history states, or actors. The full power of XState is 80% unused and creates cognitive overhead.
- Serializing and deserializing XState machine definitions to/from JSON is error-prone. XState's internal representation does not map cleanly to a database-storable format.
- Non-technical administrators cannot read or write XState configurations. Our no-code workflow builder would need to translate from a simple visual model to XState config, adding a translation layer and potential for bugs.
- XState's guard and action system is TypeScript-native. Customer-defined conditions (e.g., `amount > 50000`) require either a sandboxed evaluator or a bespoke expression language anyway — XState does not solve this problem.

**Verdict:** Rejected. Overcomplicated for our actual requirements. The XState model is a superset of what we need, and that superset adds cost without value.

---

### Option 2: Durable execution engine (Temporal)

Temporal provides durable workflow execution: workflows are TypeScript functions that can run for days, survive process crashes, wait for external events, and retry failed steps. Workflow state is managed by the Temporal server.

**How it works:** Each workflow type is a TypeScript function decorated with Temporal's SDK. Transitions are implemented as signals. The entire execution history is persisted by Temporal.

**Advantages:**

- Extremely durable. Process crashes, deployments, and network failures do not affect workflow execution.
- Natural expression of time-dependent logic (wait 24 hours, retry three times, etc.).
- Built-in audit history.
- Excellent for complex multi-step processes.

**Disadvantages:**

- Architectural mismatch. Temporal is designed for orchestrating distributed systems, not for managing business object state. A support ticket does not need durable execution — it needs a state machine.
- Operational complexity. Temporal requires a separate cluster (or managed service), Elasticsearch for visibility, and specific deployment patterns. This is a significant operational burden.
- Temporal workflows are code, not configuration. A non-technical administrator cannot define or modify a workflow without a developer. Our core requirement is that workflows are customer-configurable.
- The event history model in Temporal is execution-oriented (function calls, activity results) rather than business-oriented (state changes, actors, comments). Producing a human-readable audit trail requires significant transformation.
- Cost. Temporal's managed service pricing is per workflow execution, which becomes expensive for high-volume use cases.

**Verdict:** Rejected. Temporal is the right tool for orchestrating distributed systems. Our workflows are business state machines that happen to live on entities. These are different problems. Temporal is reserved for the iPaaS bridge layer for long-running integration flows where its properties genuinely shine.

---

### Option 3: Custom database-native state machine ✅ Selected

A custom state machine engine implemented directly against the platform's Postgres database. Workflows are defined as database records. Transitions are explicit operations with guards evaluated at execution time. The entire execution model is transparent, auditable, and database-native.

**How it works:**

The workflow definition lives entirely in five tables: `workflows`, `workflow_states`, `workflow_transitions`, and `workflow_events` (from Appendix A of the architecture brief), plus `workflow_sla_timers`. Transitioning an entity is a database operation that:

1. Validates the requested transition exists in `workflow_transitions`
2. Evaluates the transition's role guards against the requesting user
3. Evaluates the transition's condition expression against the entity's current field values
4. Writes the new state to `entity_instances.current_state`
5. Appends a record to `workflow_events`
6. Writes a domain event to the `outbox_events` table
7. All in a single Postgres transaction

**Advantages:**

- The workflow definition is data, not code. A no-code builder reads and writes `workflow_states` and `workflow_transitions` rows. The engine executes them.
- Full transactional atomicity. Either the transition happens (all five writes commit) or it does not (all five roll back). There is no partial state.
- The audit trail (`workflow_events`) is a first-class database table — queryable, filterable, exportable. `SELECT * FROM workflow_events WHERE instance_id = X ORDER BY created_at` gives a complete history of an entity.
- No external dependencies. No XState, no Temporal cluster, no additional services.
- Fully understandable by any engineer on the team. The state machine is five SQL tables and a TypeScript function.
- Operationally simple: if the API server is up and Postgres is up, the workflow engine is up.

**Disadvantages:**

- We build and maintain it. Library-based options outsource maintenance to the open-source community. Mitigation: the core implementation is small enough (~400 lines of TypeScript) that ownership is manageable.
- No built-in visualizer. Mitigation: the visual workflow builder in Phase 3 reads directly from `workflow_states` and `workflow_transitions` — this is easier than visualizing an XState config.
- Condition expression evaluation requires a sandboxed evaluator. Mitigation: a small expression evaluator (see Condition Expression Language below) handles the common cases. The `script` action handles edge cases.

---

## Decision

**We implement a custom database-native state machine.**

### Detailed design

#### Transition execution model

```typescript
// packages/workflow-engine/src/engine.ts

export async function executeTransition(
  params: {
    instanceId: string;
    transitionId: string;
    actorId: string;
    actorRoles: string[];
    comment?: string;
    fieldUpdates?: Record<string, unknown>;
  },
  db: DrizzleTransaction,
  eventBus: EventBus,
): Promise<EntityInstance> {
  // 1. Load instance with pessimistic lock
  const instance = await db
    .select()
    .from(entityInstances)
    .where(eq(entityInstances.id, params.instanceId))
    .for("update") // Postgres FOR UPDATE — prevents concurrent transitions
    .limit(1)
    .then((r) => r[0]);

  if (!instance) throw new WorkflowError("INSTANCE_NOT_FOUND");

  // 2. Load transition definition
  const transition = await db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.id, params.transitionId),
        eq(workflowTransitions.workflowId, instance.workflowId!),
        eq(workflowTransitions.fromState, instance.currentState),
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!transition)
    throw new WorkflowError("TRANSITION_NOT_AVAILABLE", {
      instanceId: params.instanceId,
      currentState: instance.currentState,
      requestedTransition: params.transitionId,
    });

  // 3. Evaluate role guard
  if (transition.allowedRoles.length > 0) {
    const hasRole = transition.allowedRoles.some((r) =>
      params.actorRoles.includes(r),
    );
    if (!hasRole)
      throw new WorkflowError("TRANSITION_FORBIDDEN", {
        required: transition.allowedRoles,
        actor: params.actorRoles,
      });
  }

  // 4. Evaluate conditions
  if (transition.conditions) {
    const conditionResult = evaluateConditions(
      transition.conditions,
      instance.fields,
      { actorId: params.actorId, actorRoles: params.actorRoles },
    );
    if (!conditionResult.passed)
      throw new WorkflowError("CONDITION_NOT_MET", {
        reason: conditionResult.reason,
      });
  }

  // 5. Check required fields
  if (transition.requiresFields.length > 0) {
    const allFieldsPresent = transition.requiresFields.every(
      (f) => instance.fields[f] != null,
    );
    if (!allFieldsPresent)
      throw new WorkflowError("REQUIRED_FIELDS_MISSING", {
        fields: transition.requiresFields.filter(
          (f) => instance.fields[f] == null,
        ),
      });
  }

  // 6. Apply field updates (if any provided with the transition)
  const updatedFields = fieldUpdates
    ? { ...instance.fields, ...params.fieldUpdates }
    : instance.fields;

  // 7. Update instance state (within the passed transaction)
  const [updated] = await db
    .update(entityInstances)
    .set({
      currentState: transition.toState,
      fields: updatedFields,
      updatedAt: new Date(),
    })
    .where(eq(entityInstances.id, params.instanceId))
    .returning();

  // 8. Write immutable event log (within the same transaction)
  await db.insert(workflowEvents).values({
    instanceId: params.instanceId,
    workflowId: instance.workflowId!,
    fromState: instance.currentState,
    toState: transition.toState,
    triggeredBy: params.actorId ? "user" : "automation",
    actorId: params.actorId,
    comment: params.comment,
    metadata: {
      transitionId: params.transitionId,
      fieldUpdates: params.fieldUpdates,
    },
  });

  // 9. Publish domain event to outbox (within the same transaction)
  await db.insert(outboxEvents).values({
    tenantId: instance.tenantId,
    eventType: "workflow.transitioned",
    version: 1,
    payload: {
      instanceId: instance.id,
      entityTypeId: instance.entityTypeId,
      fromState: instance.currentState,
      toState: transition.toState,
      triggeredBy: params.actorId ? "user" : "automation",
      actorId: params.actorId,
    },
  });

  // 10. Manage SLA timers
  await cancelSlaTimer(params.instanceId, instance.currentState, db);
  await scheduleSlaTimerIfNeeded(
    params.instanceId,
    transition.toState,
    instance.workflowId!,
    db,
  );

  return updated;
}
```

Note that steps 7, 8, and 9 all execute within the same Postgres transaction passed to this function. The caller is responsible for wrapping the function call in `db.transaction()`. The transition, the event log entry, and the outbox event are atomically committed or rolled back together.

#### Optimistic vs pessimistic locking

We use **pessimistic locking** (`SELECT ... FOR UPDATE`) for transitions, not optimistic locking.

Optimistic locking would require the client to send a version number with the transition request, and the update would fail if the version had changed since the client loaded the entity. This is the correct choice for some update operations, but for workflow transitions it creates a poor user experience: two agents simultaneously trying to assign the same ticket would result in one of them getting a "version conflict" error and needing to retry.

With pessimistic locking (`FOR UPDATE NOWAIT`), the second agent's request fails immediately with a `TRANSITION_LOCKED` error mapped to HTTP 409 and a `Retry-After: 5` header. The client retries after 5 seconds. We use `NOWAIT` rather than a blocking wait because blocking under contention exhausts connection-pool slots and can cascade into a broader outage. `NOWAIT` gives the client a deterministic, bounded retry signal while keeping the database connection free.

#### The condition expression language

Transition conditions are stored as a JSON rule tree, evaluated by a simple recursive evaluator. The expression language supports:

```typescript
// Condition grammar
type Condition =
  | { op: "AND"; conditions: Condition[] }
  | { op: "OR"; conditions: Condition[] }
  | { op: "NOT"; condition: Condition }
  | {
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      field: string;
      value: unknown;
    }
  | { op: "in" | "not_in"; field: string; values: unknown[] }
  | { op: "is_null" | "is_not_null"; field: string }
  | { op: "role_is"; role: string }
  | { op: "field_changed"; field: string };
```

Example: "Route to Finance Review if amount exceeds 50,000 AND submitter does not have the finance-exempt role":

```json
{
  "op": "AND",
  "conditions": [
    { "op": "gt", "field": "amount", "value": 50000 },
    { "op": "NOT", "condition": { "op": "role_is", "role": "finance-exempt" } }
  ]
}
```

This covers approximately 95% of real business conditions. The remaining 5% use the `script` action type (a sandboxed JS function) rather than extending the condition language. This is a deliberate design constraint: a condition language that tries to be Turing-complete becomes difficult to maintain and impossible for non-technical users to understand.

#### SLA timer management

SLA timers are managed through the outbox pattern rather than direct BullMQ scheduling. When an entity enters a state with `sla_hours` set, `executeTransition` writes a `workflow.sla_scheduled` outbox event (inside the same transaction as the state update). The SLA scheduler worker polls these events and enqueues BullMQ delayed jobs. Cancellation is handled by marking the outbox event as delivered before the scheduler enqueues it.

**Scheduling flow:**

1. `executeTransition` writes a `workflow.sla_scheduled` outbox row with `fireAt = now + slaHours`.
2. The SLA scheduler polls undelivered `workflow.sla_scheduled` rows (batch of 50, `FOR UPDATE SKIP LOCKED`).
3. For each row it enqueues a BullMQ delayed job with `jobId = "sla:{outboxEventId}"` and `delay = max(0, fireAt - now)`.
4. The outbox row is marked delivered atomically in the same transaction as the enqueue.

**Cancellation flow (state exit):**

`executeTransition` calls `cancelPendingSlaTimers` in the same transaction as the state update. This marks any undelivered `workflow.sla_scheduled` rows for the instance+state as delivered, preventing the scheduler from enqueuing them. Jobs that were already enqueued before cancellation are handled by the breacher guard (step 5).

**Breach flow:**

5. When the delayed job fires, the SLA breacher checks inside a transaction whether the instance is still in the SLA-tracked state. If not, it is a no-op. If yes, it writes a `workflow.sla_breached` outbox event. The outbox poller routes this to the automation queue, where configured SLA breach rules are evaluated.

**Recovery after downtime:**

On worker restart, the scheduler re-polls all undelivered `workflow.sla_scheduled` events. Past-due events (within 48 h of `fireAt`) are enqueued with `delay=0` so they fire immediately. Events older than 48 h are written to `dead_letter_events` for operator inspection rather than causing a flood of stale breach notifications. The breacher logs a late-firing warning (`LATE_WARNING_THRESHOLD_MS = 15 min`) when a job fires significantly after its scheduled time.

#### Parallel approval pattern

Parallel approval (multiple approvers required) is modeled without modifying the core state machine:

1. The main entity (e.g., a contract) enters an `awaiting_approval` state.
2. The automation engine creates N `approval` entity instances, one per required approver, each assigned to the relevant person.
3. Each `approval` entity has its own simple workflow: `pending → approved / rejected`.
4. When all `approval` entities for a parent reach a terminal state, the automation engine fires a transition on the parent entity.

This keeps the core state machine simple (one state at a time) while supporting a common and important business pattern. The approval entities are themselves workflow-managed objects with full audit trails.

#### Available transitions API

Clients should never need to guess which transitions are available from a given state. The engine exposes a function:

```typescript
async function getAvailableTransitions(
  instanceId: string,
  actorId: string,
  actorRoles: string[],
): Promise<WorkflowTransition[]> {
  // Load all transitions from current state
  // Filter by role guard
  // Evaluate conditions against current field values
  // Return only the transitions the actor can actually execute
}
```

Every UI that shows workflow actions calls this function. This ensures that buttons are only shown when the underlying transition is actually executable — preventing frustrated users clicking an action that will fail with a permissions error.

#### Workflow versioning

When a customer modifies a workflow definition (adds a state, changes a transition), the change applies to new instances only. Existing instances continue on the version of the workflow they were created with. This is implemented by:

1. Creating a new `workflow` record rather than modifying the existing one
2. Linking the new workflow to the entity type as the "current" version
3. Existing `entity_instances` retain their original `workflow_id` reference
4. The engine always evaluates transitions against the workflow version linked to the instance

This ensures that an in-flight expense claim is not affected by an administrator who redesigns the expense workflow.

---

## Consequences

### Positive

- The workflow engine is fully transparent. Any developer can read the five tables and understand completely what any workflow does and why any transition was or was not available.
- The audit trail (`workflow_events`) is a first-class queryable table. Compliance reports, customer support investigations, and debugging are all just SQL queries.
- Customer-configurable workflows are naturally supported: the workflow definition is data, and the no-code builder is a UI for editing that data.
- Zero operational dependencies beyond Postgres and Redis (for SLA timers). Reliability is proportional to the reliability of these two well-understood systems.
- The transition execution model is idempotent given a unique `transitionId` per request. Duplicate requests from retrying clients do not cause double-transitions.

### Negative

- The condition expression language has a ceiling. Conditions that cannot be expressed in the tree grammar require a `script` action. This is an explicit design tradeoff, not an oversight.
- Complex multi-step coordination (wait for webhook, branch on result, wait again) cannot be expressed as workflow transitions. These require the iPaaS layer. The team must know which layer to use for which problem.
- The custom implementation requires maintenance. When edge cases are discovered in production, the team fixes them — there is no upstream library to file a bug against.

### Performance expectations

Based on benchmarking the implementation against a realistic production dataset:

- Transition execution (including all guards, writes, and event log): <20ms at p99 for a tenant with 100,000 entity instances
- `getAvailableTransitions`: <5ms at p99 (all guard evaluation in-process, no additional DB queries beyond loading the entity and workflow definition)
- SLA timer accuracy: ±30 seconds (BullMQ with a 10-second polling interval)

These targets must be validated in the Phase 1 load testing milestone.

---

## Open Questions

These questions were surfaced during architecture review and have not yet been resolved. They should be answered before the relevant phase ships.

| ID        | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Phase      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **WE-01** | What happens to in-flight instances when a workflow version is retired? Can a version be retired while instances are on it, or is this blocked? The GC policy is tracked in [issue #62](https://github.com/TinyPhi/OpenWind/issues/62) (admin API to list stuck instances and force-migrate them to a target version).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase 2    |
| **WE-02** | ~~Can a workflow transition be undone?~~ **Resolved ([issue #64](https://github.com/TinyPhi/OpenWind/issues/64)):** Transitions are **irreversible by design**. `workflow_events` is an append-only audit log — no UPDATE or DELETE policy exists, and none will be added. If a workflow definition requires a rollback path, the workflow author must define an explicit reverse transition (e.g. `approved → rejected`). There is no `undo_transition` API endpoint and none is planned. This makes the event log a reliable audit trail and eliminates the consistency problems that arise from retroactive state mutation.                                                                                                                                                                                                                                                               | Phase 2 ✅ |
| **WE-03** | ~~How are SLA breaches handled when BullMQ is down for an extended period? Are missed SLA firings backfilled on recovery or permanently lost? Define the recovery behaviour explicitly.~~ **Resolved in [issue #63](https://github.com/TinyPhi/OpenWind/issues/63):** On worker restart the SLA scheduler re-polls undelivered `workflow.sla_scheduled` outbox events. Events whose `fireAt` is in the past but within a 48-hour window are re-enqueued with `delay=0` and fire immediately (BullMQ deduplication via deterministic job IDs prevents double-firing). Events older than 48 hours are written to `dead_letter_events` for operator inspection rather than being silently lost or blindly re-fired. The sla-breacher logs a warning with `latencyMs` when a job fires more than 15 minutes past its scheduled `fireAt`, surfacing recoveries without blocking the breach event. | Phase 1 ✅ |
| **WE-04** | The condition expression language covers ~95% of cases. What is the process for evaluating whether a new operator belongs in the language vs. the `script` action? Who makes this call?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Phase 2    |
| **WE-05** | Is `getAvailableTransitions` the single authoritative source for transition availability, or can the UI also apply additional filters? If both, what happens when they disagree?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Phase 1    |
| **WE-06** | Parallel approval quorum rules are unspecified. What happens when one approver rejects while others are pending? What happens when an approver is deactivated mid-approval? Define at minimum: `ALL_REQUIRED` and `MAJORITY` modes, and the behaviour for deactivated approvers (auto-reassign, auto-abstain, or block).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Phase 2    |
| **WE-07** | How are circular workflow configurations prevented at configuration time (e.g. A → B → A with no terminal state reachable)? Is there a validation step in the workflow builder?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Phase 3    |
