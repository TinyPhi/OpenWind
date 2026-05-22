# Prompt: Define a workflow for an entity type

Workflows are seed SQL rows in `workflow_states` and `workflow_transitions`.
The engine executes them — no TypeScript required.

## Reference: ADR-002

Read `docs/decisions/ADR-002-workflow-engine.md` before designing a workflow.
Key constraints:

- Every workflow must have at least one terminal state (no outgoing transitions)
- Guards: `allowed_roles[]`, `condition` (JSON rule tree), `requires_fields[]`, `requires_comment`
- SLA: `sla_hours` on a state schedules a BullMQ delayed job; fires `workflow.sla_breached` event
- Parallel approval: implemented as approval sub-entities + automation quorum check (no special engine code)

## Template prompt

"Define a workflow for the [ENTITY_TYPE] entity type.

States: [STATE NAMES — mark terminal states]
Transitions:
[FROM] → [TO]: allowed roles [ROLES], condition [CONDITION OR none], SLA [HOURS OR none]
...

Generate the SQL INSERT rows for:

- `workflows` (one row, name, entity_type_id, version = 1)
- `workflow_states` (one row per state, with sla_hours where needed)
- `workflow_transitions` (one row per arrow, with guards)

Use `{TENANT_ID}` placeholder. Target file: [modules/name/002_workflow.sql OR migration file]"

## Condition expression syntax (ADR-002 grammar)

```json
{
  "and": [
    { "op": "eq", "field": "status", "value": "pending" },
    { "op": "role_is", "value": "manager" }
  ]
}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `is_null`, `role_is`, `and`, `or`, `not`
