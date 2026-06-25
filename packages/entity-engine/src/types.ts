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
