export interface WorkflowDefinition {
  id: string;
  tenantId: string | null;
  entityTypeId: string;
  name: string;
  initialState: string;
  isActive: boolean;
  /** Zitadel user ID of the workflow's creator. Immutable; always an implicit workflow admin. */
  createdBy: string | null;
  /** Zitadel user IDs of the designated workflow admins (includes creator). Empty array = unassigned. */
  assignedTo: string[];
  /** Max parent→child chain depth. 0 = children disabled. Default 1. */
  maxChildDepth: number;
  /** Max direct children per parent. Default 10. */
  maxChildrenPerParent: number;
  createdAt: Date;
}

export interface WorkflowState {
  id: string;
  workflowId: string;
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
  slaHours: number | null;
  sortOrder: number;
}

export interface WorkflowTransition {
  id: string;
  workflowId: string;
  fromState: string;
  toState: string;
  label: string | null;
  allowedRoles: string[];
  conditions: ConditionTree | null;
  requiresComment: boolean;
  requiresFields: string[];
  sortOrder: number;
}

export interface WorkflowEvent {
  id: string;
  instanceId: string;
  workflowId: string;
  fromState: string | null;
  toState: string;
  triggeredBy: "user" | "automation" | "api" | "system";
  actorId: string | null;
  comment: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  // Identity of the executeTransition call that produced this event,
  // generated fresh each call — not persisted on workflow_events itself, so
  // historical rows read back via getWorkflowEventLog don't have one.
  // Always set on executeTransition's own return value. On the
  // idempotency-key short-circuit path (existing event, no new outbox row
  // written) it's a fresh value with no meaning to any consumer, since
  // nothing reads it off a replay. See engine.ts's executeTransition and
  // issue #143.
  transitionEventId?: string;
}

// Condition tree — evaluated against entity field values
export type ConditionTree =
  | { op: "and"; children: ConditionTree[] }
  | { op: "or"; children: ConditionTree[] }
  | { op: "not"; child: ConditionTree }
  | FieldCondition;

export interface FieldCondition {
  op:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "in"
    | "empty"
    | "not_empty";
  field: string;
  value?: unknown;
}

export interface TransitionRequest {
  instanceId: string;
  transitionId: string;
  actorId?: string;
  actorRoles?: string[];
  comment?: string;
  idempotencyKey?: string;
  triggeredBy?: "user" | "automation" | "api" | "system";
  metadata?: Record<string, unknown>;
  // Automation recursion depth this transition was triggered at. Stamped onto
  // the outbox event so the automation worker resumes MAX_DEPTH counting from
  // here instead of resetting to 0 — see issue #120.
  depth?: number;
}

export interface WorkflowFull extends WorkflowDefinition {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

export type CreateWorkflowInput = {
  entityTypeId: string;
  name: string;
  initialState: string;
};

export type UpdateWorkflowInput = {
  isActive?: boolean | undefined;
  assignedTo?: string[] | undefined;
  maxChildDepth?: number | null | undefined;
  maxChildrenPerParent?: number | null | undefined;
  /** Must name an existing, non-terminal state on this workflow — see
   * updateWorkflow's validation and addWorkflowState's auto-heal. */
  initialState?: string | undefined;
};

// Caller identity for per-workflow authorization checks (see authorization.ts).
// isGlobalAdmin bypasses all per-workflow ownership checks.
export type WorkflowCaller = {
  userId: string;
  isGlobalAdmin: boolean;
};

export type CreateWorkflowStateInput = {
  name: string;
  label: string;
  color?: string | undefined;
  isTerminal?: boolean | undefined;
  slaHours?: number | null | undefined;
  sortOrder?: number | undefined;
};

export type UpdateWorkflowStateInput = {
  name?: string | undefined;
  label?: string | undefined;
  color?: string | undefined;
  isTerminal?: boolean | undefined;
  slaHours?: number | null | undefined;
  sortOrder?: number | undefined;
};

export type CreateWorkflowTransitionInput = {
  fromState: string;
  toState: string;
  label?: string | undefined;
  allowedRoles?: string[] | undefined;
  conditions?: ConditionTree | null | undefined;
  requiresComment?: boolean | undefined;
  requiresFields?: string[] | undefined;
};

export type UpdateWorkflowTransitionInput = {
  label?: string | undefined;
  allowedRoles?: string[] | undefined;
  conditions?: ConditionTree | null | undefined;
  requiresComment?: boolean | undefined;
  requiresFields?: string[] | undefined;
};

// Domain event written to outbox on successful transition
export interface WorkflowTransitionedEvent {
  eventType: "workflow.transitioned";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  workflowId: string;
  fromState: string | null;
  toState: string;
  triggeredBy: string;
  actorId: string | null;
  occurredAt: string;
  depth?: number;
  // See WorkflowEvent.transitionEventId — carried into the outbox payload so
  // the async worker path and the sync in-process automation path can agree
  // on which transition this is, for exactly-once rule execution (#143).
  transitionEventId?: string;
}

// Domain event written to outbox when an SLA timer breaches.
// Field names match WorkflowSlaBreachedV1Schema in packages/automation-engine
// so the outbox poller's TriggerEventSchema.safeParse() succeeds without transformation.
export interface WorkflowSlaBreachedEvent {
  eventType: "workflow.sla_breached";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  workflowId: string;
  state: string;
  slaHours: number;
  breachedAt: string;
}
