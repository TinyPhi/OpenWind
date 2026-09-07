export const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "currency",
  "date",
  "datetime",
  "boolean",
  "enum",
  // "select" is an alias for "enum" -- kept as its own recognized type
  // (rather than requiring every caller to normalize it away) because it's
  // already load-bearing seed data: modules/helpdesk/seed/001_entity_types.sql
  // uses "select" as the real, on-disk value for single-choice fields --
  // adding "enum" support alone would leave those fields silently
  // unvalidated (schema-builder.ts's buildFieldSchema falls through to
  // z.unknown() for any unrecognized type, which also silently defeats
  // is_required). Found via manual testing: priority/category on the
  // helpdesk-seeded Support Ticket Lifecycle workflow could be omitted
  // entirely from a create request despite is_required=true.
  "select",
  "multi_enum",
  "user_ref",
  "entity_ref",
  "file",
  "files",
  "formula",
  "lookup",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];
