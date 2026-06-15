# Entity Engine — Context Guide

Load this when working in `packages/entity-engine/` or touching entity CRUD, field definitions,
or bulk operations.

---

## What it does

Schema-driven CRUD for any entity type without code changes. Entity types and their fields
are defined as database rows. The engine builds Zod schemas at runtime from those rows,
validates inputs, runs cross-field validators, resolves computed fields, and writes to
`entity_instances`.

---

## Key functions

| Function               | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `createEntity()`       | Insert with Zod + cross-field validation, fires audit hook                     |
| `getEntity()`          | Fetch single instance — recomputes lookups + formulas on every read            |
| `updateEntity()`       | Partial update — merges then full-validates (catches clearing required fields) |
| `deleteEntity()`       | Soft-delete only — sets `deletedAt`, never removes the row                     |
| `listEntities()`       | Cursor-paginated, lookup-batched (2 queries per relation, no N+1)              |
| `bulkCreateEntities()` | Batch insert with per-item savepoints — partial success, errors by index       |
| `addEntityField()`     | Add custom field — guarded by `allowCustomFields` on the entity type           |
| `registerValidator()`  | Register a cross-field validator keyed by entity type name                     |

---

## Invariants that will surprise you

**Validation is two-phase.** Zod validates individual fields first. Then the partial update is
merged with existing data and the full merged document is re-validated. This is how clearing
a required field via a partial PATCH is caught.

**Lookup and formula fields are never stored.** They are computed on every `getEntity()` and
`listEntities()` call. Lookups run first; formulas can reference resolved lookup values.

**Soft-delete is total.** `deletedAt` is never cleared. List queries filter `isNull(deletedAt)`
by default — pass `includeDeleted: true` explicitly to include them.

**Cross-tenant reference guard.** `entity_ref` and `user_ref` fields are validated after Zod
to confirm the referenced resource belongs to the same tenant. Failure throws `ValidationError`
with code `CROSS_TENANT_REFERENCE`.

**System fields are immutable.** Fields with `isSystem: true` cannot be deleted or modified.

**Audit hooks fire inside the transaction.** If the audit hook throws, the entire write rolls back.

**Schema is cached per `entityTypeId + tenantId`.** Cache is invalidated when fields change.
Don't bypass the cache — always use the engine functions, not raw DB queries.

---

## Tables owned

- `entity_types` — type definitions (`tenantId` may be NULL for system types)
- `entity_fields` — field definitions including computed, custom, and system fields
- `entity_instances` — instances; fields stored as JSONB, `currentState` for state machines
- `entity_relations` — typed edges between instances

---

## Errors

`EntityError` codes: `ENTITY_TYPE_NOT_FOUND`, `ENTITY_NOT_FOUND`, `FIELD_NOT_FOUND`,
`CUSTOM_FIELDS_NOT_ALLOWED`, `FORMULA_EVALUATION_FAILED`, `CROSS_TENANT_REFERENCE`.

`ValidationError` — array of `FieldError` objects (field, code, message, meta). Thrown on
Zod failure, cross-field validator failure, or cross-tenant reference violation.

---

## Gotchas

- Bulk operations load the schema **once per entityTypeId**, validate all items in parallel.
  One schema lookup, N validations.
- Idempotency is **not** enforced at the entity level — each call is a new operation.
  Idempotency lives in the workflow engine's `idempotencyKey`.
- PII/financial field redaction for `workflow_events.metadata` happens at transition time
  (in workflow-engine), not here at entity create/update time.
