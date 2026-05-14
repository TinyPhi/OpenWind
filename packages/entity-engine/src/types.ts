import type { FieldType } from "./field-types.js";

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
  createdBy?: string;
  assignedTo?: string;
  workflowId?: string;
};

export type UpdateEntityInput = {
  fields?: Record<string, unknown>;
  assignedTo?: string | null;
};

export type ListEntitiesInput = {
  entityTypeId: string;
  state?: string;
  assignedTo?: string;
  limit?: number;
  offset?: number;
};
