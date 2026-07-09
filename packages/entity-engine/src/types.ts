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
}

export type CreateEntityInput = {
  entityTypeId: string;
  fields: Record<string, unknown>;
  createdBy?: string | undefined;
  actorId?: string | undefined;
  /** Display name snapshot stored in event metadata for immutable history. */
  actorName?: string | undefined;
  assignedTo?: string | undefined;
  workflowId?: string | undefined;
  currentState?: string | undefined;
};

export type UpdateEntityInput = {
  fields?: Record<string, unknown> | undefined;
  assignedTo?: string | null | undefined;
  currentState?: string | null | undefined;
  /** Actor performing the update — used by the audit hook. */
  actorId?: string | undefined;
  actorType?: "user" | "api_key" | "system" | undefined;
  /** Display name snapshot stored in event metadata for immutable history. */
  actorName?: string | undefined;
};

export type ListEntitiesInput = {
  entityTypeId: string;
  state?: string | undefined;
  assignedTo?: string | undefined;
  fieldFilters?: Record<string, unknown> | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  includeDeleted?: boolean | undefined;
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
}

export interface EntityAssignedEvent {
  eventType: "entity.assigned";
  version: 1;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  assigneeId: string;
  assignedBy: string | null;
}
