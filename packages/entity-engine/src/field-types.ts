export const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "currency",
  "date",
  "datetime",
  "boolean",
  "enum",
  "multi_enum",
  "user_ref",
  "entity_ref",
  "file",
  "files",
  "formula",
  "lookup",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];
