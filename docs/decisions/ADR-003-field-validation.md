# ADR-003: Entity Field Validation Strategy

**Status:** Accepted  
**Date:** 2025-05  
**Deciders:** Engineering lead, Platform architect  
**Supersedes:** —  
**Superseded by:** —

---

## Context

The Entity Engine stores all field data in a Postgres `jsonb` column. This provides schema flexibility — adding a custom field to an entity type does not require a DDL migration — but it removes the database's ability to enforce field-level constraints (types, required-ness, enum membership, range limits). Those constraints must be enforced by the application.

This ADR decides:

1. **Where** validation runs: client, API boundary, domain layer, or database layer
2. **How** validation schemas are constructed at runtime from `entity_fields` configuration
3. **What** the validation error contract looks like — the format returned to clients
4. **How** custom tenant fields are validated alongside module-defined fields
5. **How** validation behaves for partial updates (PATCH semantics)
6. **How** the `formula` field type is evaluated

Getting this wrong creates one of two failure modes: over-validation that makes the system brittle and difficult to customize, or under-validation that allows corrupt data to accumulate until it breaks downstream systems.

### Requirements

- Field validation must be **schema-driven**: the validation rules live in `entity_fields`, not hardcoded in module code. A new custom field added at runtime must be immediately validated on the next write.
- Validation must be **tenant-aware**: a tenant may have added required custom fields that module code knows nothing about.
- Validation errors must be **field-granular**: clients must receive errors in the form `{ field: "amount", error: "REQUIRED" }`, not `{ message: "Validation failed" }`.
- Validation must be **non-redundant**: the same rule should not need to be expressed in both a Zod schema and an `entity_fields` record.
- The entity model must support **partial updates**: updating one field of a 30-field entity should not require sending all 30 fields.
- **Formula fields** (computed from other fields) must be recalculated and re-validated whenever their source fields change.

---

## Evaluated Options

### Option 1: Postgres constraints only

Enforce field rules via Postgres `CHECK` constraints, `NOT NULL`, and `ENUM` types applied to specific columns in the `fields` jsonb or as dedicated columns.

**How it works:** Rather than storing all field values in a `jsonb` blob, extract core fields into dedicated typed columns. Custom fields remain in `jsonb` but have no database-level constraints.

**Advantages:**

- Database enforces schema integrity. Invalid data cannot be written regardless of how the application behaves.
- Standard SQL tooling shows constraints clearly.

**Disadvantages:**

- Fundamentally incompatible with the dynamic field model. Adding a custom field requires an `ALTER TABLE` migration — which is exactly what the `jsonb` model was designed to avoid.
- Can only enforce constraints on dedicated columns, not on `jsonb` attributes without complex expression-based CHECK constraints that are nearly impossible to maintain.
- Error messages from Postgres constraint violations are not field-granular in a way that can be usefully returned to API clients.

**Verdict:** Rejected. Incompatible with the dynamic field model.

---

### Option 2: Hardcoded Zod schemas per module

Each module defines a Zod schema for its entity types in TypeScript. Validation runs against these hardcoded schemas.

```typescript
// modules/helpdesk/schemas.ts — hardcoded approach
const TicketSchema = z.object({
  subject: z.string().min(1).max(500),
  priority: z.enum(["low", "medium", "high", "critical"]),
  assigneeId: z.string().uuid().nullable(),
  // ...
});
```

**How it works:** When a ticket is created or updated, its fields are validated against `TicketSchema`. Zod errors are formatted and returned.

**Advantages:**

- Simple. No runtime schema generation. Zod schemas are static TypeScript.
- Type inference works naturally.
- Easy to understand and debug.

**Disadvantages:**

- Cannot validate custom tenant fields. A tenant who adds a required `department_code` field to their tickets gets no validation — their required field is silently accepted as null or ignored.
- Violates the schema-driven requirement. Every field constraint exists in two places: `entity_fields` (for the UI form builder) and the Zod schema (for validation). These must be kept in sync manually.
- Module code must be updated to change validation rules. A customer wanting a stricter `subject` length limit needs a code deploy.

**Verdict:** Rejected. Cannot handle tenant-defined fields. Violates DRY principle by splitting the source of truth for field rules.

---

### Option 3: Runtime schema generation from entity_fields ✅ Selected

Validation schemas are generated at runtime by reading the `entity_fields` table for the relevant entity type, constructing a Zod schema from those records, and validating the input against the generated schema.

**How it works:**

When a create or update operation arrives, the validation layer:

1. Loads all `entity_fields` records for the entity type (including both module-defined and tenant custom fields)
2. Constructs a Zod schema dynamically from those records
3. Validates the input payload against the generated schema
4. Returns field-granular errors if validation fails
5. Proceeds with the write if validation passes

The generated schema is **cached in Redis** with a short TTL (60 seconds by default, invalidated on any write to `entity_fields` for this entity type). Schema generation from `entity_fields` is fast (~2ms) but is called on every write without caching, making caching a practical necessity at scale.

**Advantages:**

- Single source of truth: `entity_fields` is the only place field rules are defined.
- Automatically validates tenant custom fields with no extra code.
- Adding or modifying a field's validation rules takes effect immediately (within TTL).
- Module code has zero field validation logic — it delegates entirely to the engine.

**Disadvantages:**

- Runtime schema generation requires careful implementation to be fast and correct.
- Caching introduces a brief window (up to 60 seconds) where a field rule change does not take effect. This is acceptable for a configuration system.
- Debugging validation failures requires inspecting `entity_fields` data rather than reading TypeScript code. Mitigated by good tooling and logging.

---

## Decision

**We adopt runtime schema generation from `entity_fields` as the single source of truth for all field validation.**

### Detailed design

#### Schema builder

```typescript
// packages/entity-engine/src/validation/schema-builder.ts

import { z } from "zod";
import type { EntityField } from "../types";

export function buildZodSchema(
  fields: EntityField[],
  mode: "create" | "update",
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    let fieldSchema = buildFieldSchema(field);

    // In update mode, all fields are optional (PATCH semantics)
    // In create mode, required fields are enforced
    if (mode === "update" || !field.isRequired) {
      fieldSchema = fieldSchema.optional();
    }

    shape[field.name] = fieldSchema;
  }

  return z.object(shape);
}

function buildFieldSchema(field: EntityField): z.ZodTypeAny {
  switch (field.fieldType) {
    case "text": {
      let s = z.string();
      if (field.config?.maxLength) s = s.max(field.config.maxLength);
      if (field.config?.pattern) s = s.regex(new RegExp(field.config.pattern));
      if (field.config?.minLength) s = s.min(field.config.minLength);
      return s;
    }

    case "longtext":
      return z.string();

    case "number": {
      let s = z.number();
      if (field.config?.min !== undefined) s = s.min(field.config.min);
      if (field.config?.max !== undefined) s = s.max(field.config.max);
      if (field.config?.decimalPlaces !== undefined) {
        s = s.refine(
          (v) => {
            const decimals = (v.toString().split(".")[1] ?? "").length;
            return decimals <= field.config.decimalPlaces;
          },
          { message: `Maximum ${field.config.decimalPlaces} decimal places` },
        );
      }
      return s;
    }

    case "currency":
      return z.object({
        amount: z.number().nonnegative(),
        currency: field.config?.allowedCurrencies
          ? z.enum(field.config.allowedCurrencies)
          : z.string().length(3),
      });

    case "date":
      return z.string().date();

    case "datetime":
      return z.string().datetime({ offset: true });

    case "boolean":
      return z.boolean();

    case "enum": {
      const values = field.config?.options?.map(
        (o: { value: string }) => o.value,
      );
      if (!values?.length) return z.string();
      return z.enum(values as [string, ...string[]]);
    }

    case "multi_enum": {
      const values = field.config?.options?.map(
        (o: { value: string }) => o.value,
      );
      if (!values?.length) return z.array(z.string());
      return z.array(z.enum(values as [string, ...string[]]));
    }

    case "user_ref":
      return z.string().uuid();

    case "entity_ref":
      return z.string().uuid();

    case "file":
      return z.object({
        key: z.string(),
        name: z.string(),
        size: z.number().int().positive(),
        mimeType: z.string(),
      });

    case "files":
      return z
        .array(
          z.object({
            key: z.string(),
            name: z.string(),
            size: z.number().int().positive(),
            mimeType: z.string(),
          }),
        )
        .max(field.config?.maxCount ?? 20);

    case "formula":
      // Formula fields are computed, never written by clients
      return z.never().optional();

    default:
      return z.unknown();
  }
}
```

#### Schema cache

```typescript
// packages/entity-engine/src/validation/schema-cache.ts

import { redis } from "../../redis";
import { db } from "../../db";

const CACHE_TTL_SECONDS = 60;

export async function getValidationSchema(
  entityTypeId: string,
  tenantId: string,
  mode: "create" | "update",
): Promise<z.ZodObject<Record<string, z.ZodTypeAny>>> {
  const cacheKey = `schema:${entityTypeId}:${tenantId}:${mode}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    // We can't serialize a Zod schema, so we cache the field definitions
    // and rebuild the Zod schema from them. The rebuild is <1ms.
    const fields = JSON.parse(cached) as EntityField[];
    return buildZodSchema(fields, mode);
  }

  // Load module-defined fields + tenant custom fields
  const fields = await db
    .select()
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityTypeId),
        or(
          isNull(entityFields.tenantId), // module-defined
          eq(entityFields.tenantId, tenantId), // tenant custom
        ),
      ),
    )
    .orderBy(entityFields.sortOrder);

  await redis.set(cacheKey, JSON.stringify(fields), { EX: CACHE_TTL_SECONDS });

  return buildZodSchema(fields, mode);
}

// Called when any entity_field record is modified
export async function invalidateSchemaCache(
  entityTypeId: string,
  tenantId?: string,
): Promise<void> {
  const pattern = tenantId
    ? `schema:${entityTypeId}:${tenantId}:*`
    : `schema:${entityTypeId}:*`;

  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(keys);
}
```

#### Validation error format

Validation failures are returned as a structured `ValidationError` with field-level granularity. HTTP status is always 422 (Unprocessable Entity).

```typescript
export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly fields: FieldError[];

  constructor(fields: FieldError[]) {
    super("Validation failed");
    this.fields = fields;
  }
}

export interface FieldError {
  field: string; // 'amount' | 'contact.email' (nested fields use dot notation)
  code: string; // 'REQUIRED' | 'TOO_LONG' | 'INVALID_ENUM' | 'INVALID_FORMAT'
  message: string; // Human-readable message
  meta?: Record<string, unknown>; // Additional context (e.g., maxLength: 500)
}
```

Zod errors are transformed into this format before being returned to clients:

```typescript
function transformZodErrors(error: z.ZodError): FieldError[] {
  return error.errors.map((issue) => ({
    field: issue.path.join("."),
    code: mapZodCode(issue.code),
    message: issue.message,
    meta:
      issue.code === "too_big"
        ? { max: issue.maximum }
        : issue.code === "too_small"
          ? { min: issue.minimum }
          : issue.code === "invalid_enum_value"
            ? { options: issue.options }
            : undefined,
  }));
}

function mapZodCode(code: z.ZodIssueCode): string {
  const map: Record<string, string> = {
    invalid_type: "INVALID_TYPE",
    too_small: issue.type === "string" ? "TOO_SHORT" : "TOO_SMALL",
    too_big: issue.type === "string" ? "TOO_LONG" : "TOO_LARGE",
    invalid_enum_value: "INVALID_ENUM",
    invalid_string: "INVALID_FORMAT",
    custom: "VALIDATION_FAILED",
  };
  return map[code] ?? "INVALID";
}
```

Example error response:

```json
{
  "error": "VALIDATION_ERROR",
  "fields": [
    {
      "field": "amount",
      "code": "REQUIRED",
      "message": "Amount is required"
    },
    {
      "field": "priority",
      "code": "INVALID_ENUM",
      "message": "Priority must be one of: low, medium, high, critical",
      "meta": { "options": ["low", "medium", "high", "critical"] }
    }
  ]
}
```

#### PATCH semantics for partial updates

A `PATCH` request updates only the fields provided. Omitted fields are not validated for presence — only the fields included in the request body are validated.

The mode parameter in `getValidationSchema('create' | 'update')` handles this:

- In `create` mode, all fields marked `is_required = true` must be present in the payload
- In `update` (PATCH) mode, all fields are optional. Only provided fields are validated against their type/format/range rules

```typescript
// Entity update endpoint
app.patch("/entities/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { entityTypeId, tenantId } = c.get("entityContext");

  // Build schema in 'update' mode — all fields optional
  const schema = await getValidationSchema(entityTypeId, tenantId, "update");
  const result = schema.safeParse(body.fields);

  if (!result.success) {
    throw new ValidationError(transformZodErrors(result.error));
  }

  // Merge with existing fields (PATCH, not PUT)
  const existing = await loadEntity(id);
  const mergedFields = { ...existing.fields, ...result.data };

  // Re-validate merged result as a full 'create' to catch required field
  // violations that would result from this update (e.g., setting a required
  // field to null is caught here)
  const fullSchema = await getValidationSchema(
    entityTypeId,
    tenantId,
    "create",
  );
  const fullResult = fullSchema.safeParse(mergedFields);

  if (!fullResult.success) {
    throw new ValidationError(transformZodErrors(fullResult.error));
  }

  return updateEntity(id, fullResult.data);
});
```

The two-step validation for PATCH is important: the partial payload is validated to catch type errors in provided fields, then the merged result is validated against the full schema to catch cases where a PATCH is attempting to clear a required field.

#### Cross-field validation

Some validation rules span multiple fields: "either `email` or `phone` must be provided", "end_date must be after start_date". These cannot be expressed as single-field rules in `entity_fields`.

This is handled via **entity-level validators**: optional TypeScript functions registered by modules that receive the full (merged) field set after field-level validation passes. Module code can register validators:

```typescript
// modules/crm/validators.ts
entityEngine.registerValidator("contact", (fields, mode) => {
  if (mode === "create" && !fields.email && !fields.phone) {
    return [
      {
        field: "email",
        code: "CROSS_FIELD_REQUIRED",
        message: "Either email or phone must be provided",
      },
    ];
  }
  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) {
    return [
      {
        field: "endDate",
        code: "INVALID_RANGE",
        message: "End date must be after start date",
      },
    ];
  }
  return [];
});
```

Cross-field validators run after field-level validation passes. Their errors are merged into the same `ValidationError` format.

#### Formula field evaluation

Formula fields are read-only computed values. They are stored in the `fields` jsonb column but are never written by clients (their Zod schema returns `z.never().optional()`).

Formula fields are recalculated:

- On every entity read (lazy computation)
- After every write that modifies a field referenced in any formula

Formula expressions are sandboxed JavaScript evaluated with `isolated-vm`:

```typescript
// packages/entity-engine/src/validation/formula-evaluator.ts

import Isolate from "isolated-vm";

const isolate = new Isolate({ memoryLimit: 8 }); // 8MB limit

export async function evaluateFormula(
  expression: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  const context = await isolate.createContext();
  const jail = context.global;

  // Expose only the field values, no globals
  await jail.set("fields", new Isolate.ExternalCopy(fields).copyInto());

  try {
    const script = await isolate.compileScript(
      `(function() { return (${expression}); })()`,
    );
    const result = await script.run(context, { timeout: 100 }); // 100ms limit
    return result;
  } catch (err) {
    // Formula evaluation errors do not fail the request — they return null
    // and are logged for the administrator to investigate
    logger.warn("Formula evaluation failed", { expression, error: err });
    return null;
  } finally {
    context.release();
  }
}
```

Example formula field configuration:

```json
{
  "name": "total_with_tax",
  "fieldType": "formula",
  "config": {
    "expression": "fields.subtotal * (1 + fields.tax_rate / 100)",
    "outputType": "number",
    "decimalPlaces": 2
  }
}
```

Formula evaluation is intentionally limited: no network access, no file system, no `setTimeout`, 100ms execution limit, 8MB memory limit. A formula that times out or throws an error returns `null` rather than failing the entire request.

#### Validation in the automation engine

The automation engine's `set_field` action updates entity fields. These updates go through the same validation pipeline as client-initiated updates — the automation engine is not exempt. This ensures data integrity even for programmatic field changes.

```typescript
// In automation engine action execution:
case 'set_field': {
  const schema = await getValidationSchema(
    instance.entityTypeId,
    instance.tenantId,
    'update'
  );
  const result = schema.safeParse({ [action.config.field]: action.config.value });
  if (!result.success) {
    // Log as automation execution error, do not crash the automation
    throw new AutomationError('FIELD_VALIDATION_FAILED', {
      field: action.config.field,
      errors: transformZodErrors(result.error),
    });
  }
  // Apply validated update
  break;
}
```

---

## Consequences

### Positive

- Single source of truth for all field rules. A field's constraints are defined once in `entity_fields` and enforced consistently across API calls, automations, and imports.
- Tenant custom fields are automatically validated. No module code changes needed when a tenant adds or modifies a field.
- Validation errors are always field-granular. Clients can display inline validation messages alongside the relevant form fields.
- PATCH semantics are handled correctly: required fields are only enforced for creates and when a PATCH attempts to explicitly clear them.

### Negative

- Schema cache must be invalidated correctly. A missed invalidation means field rule changes don't take effect for up to 60 seconds. The `invalidateSchemaCache` function is called by the `entity_fields` update handlers — this is a code path that must be tested explicitly.
- Formula evaluation in `isolated-vm` adds ~5ms per formula field per read. For entities with many formula fields that are read frequently, this can be noticeable. Mitigation: formula results are cached in the `fields` jsonb column and only recomputed when source fields change.
- The dynamic Zod schema cannot be statically type-checked. TypeScript cannot infer the shape of a schema built at runtime. This means the validated output is typed as `Record<string, unknown>` rather than a specific interface. Mitigation: module code that depends on specific field types uses Zod's `.parse()` on the known fields it cares about after the entity-level validation has passed.

### Testing requirements

The validation layer requires a specific test strategy:

1. **Unit tests for schema builder:** Every field type is tested in isolation — correct schema is generated from a given `EntityField` record, correct errors are produced for invalid values.

2. **Integration tests for cache:** Schema changes in `entity_fields` invalidate the cache. A field added after initial schema load is included in the next validation call (after TTL or explicit invalidation).

3. **Tenant isolation tests for custom fields:** Tenant A's custom required field is enforced for Tenant A but not for Tenant B on the same entity type.

4. **PATCH semantics tests:** Updating one field does not require providing all other fields. Setting a required field to null is rejected. Setting an optional field to null clears it.

5. **Formula evaluation tests:** Common formula expressions are evaluated correctly. Formulas that timeout or throw return null without failing the request. Formulas are recalculated when source fields change.

---

## Open Questions

These questions were surfaced during architecture review and have not yet been resolved. They should be answered before the relevant phase ships.

| ID        | Question                                                                                                                                                                                                                                                                                                                                                                                                                                   | Phase   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **EV-01** | Still open (confirmed 2026-08-24) — and not yet even reachable: `UpdateEntityFieldInput` (`packages/entity-engine/src/entity-fields.ts`) has no `fieldType` property, and `updateEntityField` never writes one. There is no code path that changes a field's type post-creation at all. The migration/backfill policy still needs deciding before that mutation is ever added — the question presupposes a feature that doesn't exist yet. | Phase 2 |
| **EV-02** | Still open (confirmed 2026-08-24): `deleteEntityField` does an unconditional delete with only an `isSystem` guard — no check against automation rule configs, formula expressions, or workflow transition conditions. The engine's only "reference" concept (`ref-validator.ts`) validates instance-data references across tenants, unrelated to field-definition deletion. No reference-check exists anywhere.                            | Phase 2 |
| **EV-03** | Still open (confirmed 2026-08-24): `formula-evaluator.ts`'s `evaluateFormula` returns `null` both when `isolated-vm` isn't installed and when the isolate throws/times out — the catch block just logs and returns `null`, with no accompanying status field. `applyFormulaFields` writes that `null` straight into the result with no evaluation-status metadata anywhere in the API response shape. Unchanged since the ADR was written. | Phase 2 |
| **EV-04** | Still open (confirmed 2026-08-24): `MAX_FIELD_COUNT` is only the naming-convention example in `code-style.md` — grepping the actual codebase for it (or `maxFieldCount`/`max_field_count`) returns nothing. No cap, no benchmark at any field-count tier. Needs both a policy decision (should there be a cap) and real measurement.                                                                                                       | Phase 2 |
| **EV-05** | Still open (confirmed 2026-08-24): `crossFieldValidators` (`packages/entity-engine/src/engine.ts`) is still an in-memory `Map` populated by module/engine code at startup — data-driven, no-code registration doesn't exist. No admin-ui builder or DB-backed rule table was found. Unchanged since the ADR, still an explicit no-code gap.                                                                                                | Phase 3 |
