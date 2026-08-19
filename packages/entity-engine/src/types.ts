import type { FieldType } from "./field-types.js";
import type { FieldError } from "./errors.js";

/** PII classification for a field — controls redaction in workflow_events.metadata. */
export type FieldSensitivity = "public" | "internal" | "pii" | "financial";

export interface EntityType {
  id: string;
  tenantId: string | null;
  name: string;
  plural: string;
  icon: string | null;
  moduleId: string | null;
  allowCustomFields: boolean;
  createdAt: Date;
}

export interface EntityField {
  id: string;
  entityTypeId: string;
  tenantId: string | null;
  name: string;
  label: string;
  fieldType: FieldType;
  config: Record<string, unknown>;
  isRequired: boolean;
  isIndexed: boolean;
  isSystem: boolean;
  sortOrder: number;
  /** PII classification — governs redaction in workflow_events.metadata. */
  sensitivity: FieldSensitivity;
  createdAt: Date;
}

export interface EntityInstance {
  id: string;
  entityTypeId: string;
  tenantId: string;
  workflowId: string | null;
  currentState: string;
  fields: Record<string, unknown>;
  createdBy: string | null;
  assignedTo: string | null;
  /** System field, independent of workflow state/SLA — docs/specs/due-date.md. */
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface EntityRelation {
  id: string;
  tenantId: string;
  fromInstanceId: string;
  toInstanceId: string;
  relationType: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export type CreateChildRelationInput = {
  parentId: string;
  childFields: Record<string, unknown>;
  entityTypeId: string;
  assignedTo?: string | undefined;
  createdBy?: string | undefined;
  /** ISO datetime string, or null. Independent of workflow state/SLA. */
  dueDate?: string | null | undefined;
};

export type MoveChildRelationInput = {
  childId: string;
  newParentId: string | null;
};

export type ArchiveResult =
  | { requiresConfirm: true; childCount: number }
  | { archived: true; count: number };

export type CreateEntityInput = {
  entityTypeId: string;
  fields: Record<string, unknown>;
  createdBy?: string | undefined;
  actorId?: string | undefined;
  /** Display name snapshot stored in event metadata for immutable history. */
  actorName?: string | undefined;
  assignedTo?: string | undefined;
  /** ISO datetime string, or null. Independent of workflow state/SLA. */
  dueDate?: string | null | undefined;
  workflowId?: string | undefined;
  currentState?: string | undefined;
  /**
   * Automation-engine recursion depth (#120/#218), set only by
   * executeCreateEntityAction when this creation is itself driven by an
   * automation rule. Root callers (API routes) must never set this. When
   * present, the resulting entity.created outbox event carries `depth + 1`
   * so apps/worker/src/automation-worker.ts can enforce MAX_DEPTH across the
   * async outbox hop instead of resetting to 0.
   */
  depth?: number | undefined;
};

export type UpdateEntityInput = {
  fields?: Record<string, unknown> | undefined;
  assignedTo?: string | null | undefined;
  /** ISO datetime string, or null to clear. Independent of workflow state/SLA. */
  dueDate?: string | null | undefined;
  currentState?: string | null | undefined;
  /** Actor performing the update — used by the audit hook. */
  actorId?: string | undefined;
  actorType?: "user" | "api_key" | "system" | undefined;
  /** Display name snapshot stored in event metadata for immutable history. */
  actorName?: string | undefined;
  /**
   * Automation-engine recursion depth (#120), set only by
   * executeSetFieldAction when this update is itself driven by an automation
   * rule. Root callers (API routes) must never set this. When present, the
   * resulting entity.assigned outbox event carries `depth + 1` so
   * apps/worker/src/automation-worker.ts can enforce MAX_DEPTH across the
   * async outbox hop instead of resetting to 0.
   */
  depth?: number | undefined;
};

export type ListEntitiesInput = {
  entityTypeId: string;
  state?: string | undefined;
  assignedTo?: string | undefined;
  /**
   * Non-privileged-caller scoping: matches instances where this user is
   * createdBy, assignedTo, or holds an __accessUsers ACL grant — not
   * assignedTo alone. Callers must derive this only from the authenticated
   * userId, never from a request query parameter (see
   * apps/api/src/routes/entities/list.ts's "query param cannot override
   * scope" guard) — passing it alongside `assignedTo` applies both as an AND.
   */
  scopeToUserId?: string | undefined;
  fieldFilters?: Record<string, unknown> | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  includeDeleted?: boolean | undefined;
  rootOnly?: boolean | undefined;
};

export type SearchEntitiesInput = {
  entityTypeId: string;
  query: string;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export const BULK_MAX_ITEMS = 100;

export type BulkCreateResult = {
  created: EntityInstance[];
  errors: Array<{ index: number; fields: FieldError[] }>;
};

export type BulkUpdateResult = {
  updated: EntityInstance[];
  errors: Array<{
    index: number;
    id: string;
    code: string;
    fields?: FieldError[];
  }>;
};

export type BulkSetStateResult = {
  updatedIds: string[];
  errors: Array<{ index: number; id: string; code: string }>;
};

// Domain events written to outbox on entity create/assignment.
// Field names match EntityCreatedV1Schema / EntityAssignedV1Schema in
// packages/automation-engine/src/event-schemas.ts so the outbox poller's
// TriggerEventSchema.safeParse() succeeds without transformation. Defined
// locally (not imported from automation-engine) because entity-engine may
// only depend on db — automation-engine already depends on entity-engine, so
// the reverse import would be a cycle.
//
// MUST MATCH packages/automation-engine/src/event-schemas.ts's
// EntityCreatedV1Schema / EntityAssignedV1Schema — nothing enforces this at
// compile time. If that schema gains a required field, update these
// interfaces too, or entity.created/entity.assigned outbox rows will start
// failing TriggerEventSchema.safeParse() in production and every rule
// triggered by them will silently stop firing (see the drift-detection
// assertion in apps/api/tests/isolation/entity-created-trigger.isolation.test.ts).
export interface EntityCreatedEvent {
  eventType: "entity.created";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  fields: Record<string, unknown>;
  createdBy: string | null;
  // In-process recursion depth, set only when this creation was driven by
  // the automation engine's create_entity action (#218) — see createEntity's
  // `depth` input. Absent means depth 0 (a root-triggered creation).
  depth?: number;
}

export interface EntityAssignedEvent {
  eventType: "entity.assigned";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  assigneeId: string;
  assignedBy: string | null;
  // In-process recursion depth, set only when this update was driven by the
  // automation engine's set_field action (#120) — see updateEntity's `depth`
  // input. Absent means depth 0 (a root-triggered assignment).
  depth?: number;
}

// Fires alongside entity.assigned whenever a ticket's assignedTo changes away
// from a real, previously-assigned user — notifies the user who LOST the
// assignment, distinct wording/audience from entity.assigned's "you were
// assigned" (which only ever notifies the new assignee). Never fires on a
// first-time assignment (previousAssigneeId is always non-null by
// construction — see updateEntity/bulkUpdateEntities' emission guard).
export interface EntityUnassignedEvent {
  eventType: "entity.unassigned";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  previousAssigneeId: string;
  actorId: string | null;
  depth?: number;
}

// Internal scheduling marker consumed only by
// apps/worker/src/due-date-scheduler.ts — NOT an automation trigger, so it
// must never be added to apps/worker/src/outbox-poller.ts's allowlist (see
// that file's comment on the workflow.sla_scheduled bug class this mirrors).
export interface EntityDueDateScheduledEvent {
  eventType: "entity.due_date_scheduled";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  dueDate: string;
}
