export type EntityErrorCode =
  | "ENTITY_TYPE_NOT_FOUND"
  | "ENTITY_NOT_FOUND"
  | "FIELD_VALIDATION_FAILED"
  | "CUSTOM_FIELDS_NOT_ALLOWED"
  | "FIELD_NAME_CONFLICT"
  | "RELATION_TARGET_NOT_FOUND"
  | "FORMULA_EVALUATION_FAILED";

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
