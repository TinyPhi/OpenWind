export interface WorkflowDefinition {
  id: string;
  tenantId: string | null;
  entityTypeId: string;
  name: string;
  initialState: string;
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
  triggeredBy?: "user" | "automation" | "api" | "system";
  metadata?: Record<string, unknown>;
}

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
}
