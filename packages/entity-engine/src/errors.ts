export type EntityErrorCode =
  | "ENTITY_TYPE_NOT_FOUND"
  | "ENTITY_TYPE_HAS_INSTANCES"
  | "ENTITY_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "FIELD_VALIDATION_FAILED"
  | "SYSTEM_FIELD_IMMUTABLE"
  | "CUSTOM_FIELDS_NOT_ALLOWED"
  | "FIELD_NAME_CONFLICT"
  | "RELATION_NOT_FOUND"
  | "RELATION_TARGET_NOT_FOUND"
  | "FORMULA_EVALUATION_FAILED"
  | "CHILD_ALREADY_HAS_PARENT"
  | "CHILD_DEPTH_EXCEEDED"
  | "CHILDREN_CAP_EXCEEDED"
  | "CHILD_CYCLE_DETECTED"
  | "CHILDREN_DISABLED"
  | "ENTITY_HAS_ACTIVE_CHILDREN";

export class EntityError extends Error {
  constructor(
    public readonly code: EntityErrorCode,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "EntityError";
  }
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly fields: FieldError[];

  constructor(fields: FieldError[]) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fields = fields;
  }
}
