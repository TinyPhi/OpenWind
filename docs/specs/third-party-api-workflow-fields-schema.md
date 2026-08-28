# Third-Party API — Workflow Field Schema Endpoint

> `GET /workflows/:id/fields` — exposes a workflow's entity-type field schema so third-party
> integrations can render a real create-ticket form, instead of discovering required fields via
> repeated `422` failures. Standard pattern (Jira `createmeta`, Zendesk `ticket_fields`,
> Salesforce `describe`) — a real gap vs. comparable competitors, not a nice-to-have.

status: implemented
created: 2026-08-28
updated: 2026-08-28

---

## §G Goal

A third-party integration can call one endpoint, given a `workflowId` from `GET /workflows`, and
get back everything needed to render an accurate ticket-creation form: every field's name, label,
type, required/optional, sensitivity, and type-specific config (enum values, currency shape,
etc.) — with zero trial-and-error against `POST /tickets`.

---

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | `apps/api` (Hono third-party route), reuses `packages/entity-engine`'s existing field-lookup service — no new package                                                                                                                             |
| perf         | No explicit latency target set — same posture as `GET /workflows` (single indexed lookup, no pagination)                                                                                                                                          |
| auth         | Identical dual-identity flow to every other third-party route (`requireAuth`, `requireActingPerson`, scope check) — `entity:ticket:read`, same scope `GET /workflows` already requires                                                            |
| access model | Tenant-wide visibility, no per-ticket/per-instance access check — mirrors `GET /workflows` itself, which also has no per-instance gate (this is schema metadata, not ticket data)                                                                 |
| out of scope | Full JSON-Schema/OpenAPI generation — flat field-list shape only, matching Jira/Zendesk/Salesforce precedent                                                                                                                                      |
| out of scope | Exposing workflow transitions or their `allowed_roles`/IDs — separate, already-known gap, not this spec                                                                                                                                           |
| out of scope | Any per-workflow field override mechanism — confirmed not to exist in the schema (`entity_fields` is keyed by `entityTypeId` only, no `workflowId` column anywhere) — this endpoint reports what's already there, does not add new config surface |
| out of scope | Changing `POST /tickets`'s own validation or its `422` discovery-loop behavior — purely additive, existing integrations unaffected                                                                                                                |
| out of scope | Exposing actual field _data_/ticket instance values — schema only                                                                                                                                                                                 |

---

## §I Interfaces

**Route:** `GET /api/v1/workflows/:workflowId/fields`

Resolves `workflowId` → `entityTypeId` internally (workflow row already stores this), then looks
up that entity type's fields — the URL is ergonomic (one hop for the caller, matches how a ticket
is actually created: "give me the form for this workflow"), even though the underlying data is
entity-type-scoped, not workflow-scoped.

**Response — 200:**

```json
{
  "data": {
    "workflowId": "5298ff3d-79c8-43bf-8c45-ef38760c54a8",
    "entityTypeId": "3c199154-9340-4642-b7a6-700ef3016110",
    "fields": [
      {
        "name": "title",
        "label": "Title",
        "type": "text",
        "required": true,
        "sensitivity": "public",
        "config": {}
      },
      {
        "name": "amount",
        "label": "Amount",
        "type": "currency",
        "required": true,
        "sensitivity": "financial",
        "config": {}
      },
      {
        "name": "category",
        "label": "Category",
        "type": "enum",
        "required": false,
        "sensitivity": "public",
        "config": { "values": ["travel", "meals", "supplies"] }
      }
    ]
  }
}
```

- `fields` includes every field on the entity type — required and optional, `isSystem` and not
  (see §R3 for why `isSystem` is irrelevant to inclusion here), **and both global (module-provided,
  `tenantId IS NULL`) and tenant-specific fields** — the same union `entity-engine`'s own
  validation already reads (see §R1's third criterion). Ordered by each field's stored `sortOrder`.
- `name` is exactly the key a caller uses in `POST /tickets`'s `fields` object and exactly what
  today's `422 VALIDATION_ERROR` response's `fields[].field` already names — wire-compatible with
  the existing discovery-loop mechanism, not a parallel naming scheme.
- `sensitivity` is the field's classification (`public`/`internal`/`pii`/`financial`) — metadata
  only; there is no actual field value anywhere in this response to redact.
- `config` is passed through as stored (shape varies per `type`, per
  `packages/entity-engine/src/field-types.ts`) — this endpoint does not reinterpret or restrict it.

**Errors:** identical shape/semantics to `GET /workflows`:

- `404 NOT_FOUND` — workflow doesn't exist, or belongs to another tenant (existence-oracle
  convention, never a distinguishable 403 for this case)
- `403 FORBIDDEN` — key lacks `entity:ticket:read`
- `401 UNAUTHORIZED` — missing/invalid/stale auth, generic per existing convention

---

## §R Requirements

R1: A caller with `entity:ticket:read` and a valid workflow ID gets the full field schema for
that workflow's entity type.
✓ Response includes every field: name, label, type, required, sensitivity, config.
✓ Field `name` values match `POST /tickets`'s existing `fields` payload keys for the same entity
type exactly (cross-checked against an existing `422` response for the same workflow).
✓ Response includes BOTH global (module-provided, `tenantId IS NULL`) and tenant-specific fields
on the entity type — the identical union `entity-engine`'s own create/update-time validation
already reads. A field visible only globally (no tenant-specific override) must still appear.
✓ Fields are ordered by their stored `sortOrder`, matching the order a human-facing create form
would render them in.
✓ A workflow with zero custom fields returns `fields: []`, not an error.

R6: The response always reflects the entity type's CURRENT field configuration — never a stale
cached view that could drift from what `POST /tickets` will actually accept or reject.
✓ A field added/edited/removed immediately before a call to this endpoint is reflected in that
same call's response — no observable staleness window distinct from whatever consistency
guarantee `entity-engine`'s own field-validation path already provides (this endpoint introduces
no NEW caching layer of its own; it inherits whichever guarantee the underlying lookup has).
✓ If entity-engine's field lookup is ever changed to add a cache, this endpoint's own tests catch
a drift between "what this endpoint reports" and "what `POST /tickets` actually validates against"
— see the wire-compatibility invariant in §V.

R7: This endpoint sits behind the identical rate-limiting middleware chain as every other
third-party route.
✓ All 3 ADR-013 tiers (per-tenant, per-key, per-key-and-person) apply — verified by an isolation
test confirming the standard `x-ratelimit-key-person-*` headers are present on a successful
response, the same way `GET /workflows` already does.

R2: Sensitivity is exposed as metadata only — never as a vector for leaking actual data.
✓ A `pii`/`financial` field's `sensitivity` value appears in the schema.
✓ No ticket instance data of any kind appears anywhere in the response (schema has none to leak
by construction, not by a redaction step).

R3: `isSystem` fields are included identically to non-system fields.
✓ A field with `isSystem: true` on its `entity_fields` row appears in the response with the same
shape as any other field — `isSystem` governs admin-side edit/delete protection on the field's own
definition (`SYSTEM_FIELD_IMMUTABLE`), not whether the field accepts a value on ticket creation,
so it has no bearing on inclusion here.

R4: Access control matches `GET /workflows` exactly — no new access model introduced.
✓ Same scope requirement (`entity:ticket:read`).
✓ No per-ticket-instance check — any acting person in the tenant with a scoped key can fetch any
workflow's schema, same as they can already list all workflows.
✓ Cross-tenant or nonexistent workflow ID → identical 404.

R5: This endpoint is purely additive — no existing behavior changes.
✓ `POST /tickets`'s `422`-driven discovery loop continues to work unchanged for any integration
that doesn't adopt this endpoint.
✓ `GET /workflows`'s own response shape is unchanged.
✓ Existing `GET /workflows` and `POST /tickets` isolation/unit suites pass unmodified alongside
the new endpoint's own tests (explicit regression gate, not just an incidental CI side effect).

---

## §V Invariants

- Field identifiers returned here are ALWAYS identical to the identifiers `POST /tickets`
  validates against for the same entity type — any drift between the two would silently break
  every integration relying on this schema to build its form.
- This endpoint never returns ticket instance data, under any field sensitivity or config —
  it describes shape, never content.
- `isSystem` never gates inclusion in this response — only ADR-level admin-edit protection.
- This response's field set is ALWAYS the same global+tenant-specific union entity-engine's own
  validation reads — never a narrower or differently-scoped query invented for this endpoint.
- This endpoint introduces no independent caching layer — whatever staleness/consistency
  guarantee the underlying entity-engine field lookup has is the guarantee this endpoint has,
  with no separate cache of its own to fall further out of sync.

---

## §T Tasks

| id  | task                                                                                                                                                                                                                                                             | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Add `GET /workflows/:workflowId/fields` route in `apps/api/src/routes/third-party/` — resolve workflow → entityTypeId, reuse entity-engine's existing global+tenant-specific field lookup verbatim (no new/narrower query)                                       | 1     | done   | —       |
| T2  | Wire dual-identity auth + `entity:ticket:read` scope check + standard rate-limit middleware, identical pattern to `GET /workflows` (R7)                                                                                                                          | 1     | done   | T1      |
| T3  | Shape the response per §I — field name/label/type/required/sensitivity/config, `isSystem` included, ordered by `sortOrder` (R1)                                                                                                                                  | 1     | done   | T1      |
| T4  | Isolation tests: happy path (incl. a global-only field and sort-order assertion), zero-fields workflow, cross-tenant 404, missing-scope 403, unauth 401, rate-limit headers present (R7), field-name wire-compatibility check against a live `422` response (R6) | 1     | done   | T2,T3   |
| T5  | Regression check: existing `GET /workflows` and `POST /tickets` isolation/unit suites still pass unmodified (R5)                                                                                                                                                 | 1     | done   | T4      |
| T6  | Update the partner-facing API reference doc (`work docs/OW/API exposur/third-party-api-reference.md` — `docs/third-party-api-design.md` does not exist in-repo) with the new endpoint                                                                            | 2     | done   | T5      |
| T7  | (Follow-up, separate PR, outside this repo) Wire OWTesterUI's Create Ticket panel to call this instead of raw-JSON textarea                                                                                                                                      | 2     | todo   | T5      |

phase gate: all unit + isolation tests pass

---

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
