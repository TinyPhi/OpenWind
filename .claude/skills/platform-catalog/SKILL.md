---
name: platform-catalog
description: Read-only lookups against OpenWind's catalog tables (modules, entity_types, workflows, workflow_states, workflow_transitions, automation_rules, connector_definitions, plugin_definitions) via psql, instead of grepping seed SQL files. Invoke when asked what modules/workflows/entity types/connectors/plugins exist, how a workflow's states/transitions are wired, or before writing a migration/seed file that touches one of these tables (to check existing naming/slug conventions first).
---

# Skill: platform-catalog

Fast, read-only answers to "what already exists" questions about OpenWind's config-first
catalog — without grepping every `packages/db/migrations/*.sql` and `modules/**/*.sql` file
by hand. This is a lookup tool, not a data-modification path.

---

## When to use

- "What modules/workflows/entity types/connectors/plugins does this tenant/the platform have?"
- "What states and transitions does the `ticket` workflow have?"
- Before writing a new module seed, migration, or workflow config — to check existing slugs,
  naming conventions, or whether something similar already exists (ADR-004 config-first design).
- Answering questions about the module/connector/plugin catalog pattern (ADR-005/ADR-009/ADR-011).

Not for: application data debugging (entity instances, tickets, tenant records) — those are
tenant-scoped and need the app's own tenant-context tooling, not this skill. Not for writes —
this skill is `SELECT` only; use a migration or seed file to change catalog data.

---

## Connecting

Requires the dev stack running (`docker compose up -d`). Run queries against the `postgres`
service directly, as the `platform` superuser — this bypasses RLS, which is fine here because
catalog tables are either platform-wide (`modules`, `connector_definitions`,
`plugin_definitions`) or have `tenant_id IS NULL` for system/template rows
(`entity_types`, `workflows`) per ADR-007. Never use this superuser connection pattern to look
at tenant-owned data — that needs the app's `withTenantContext` role-switch, not raw psql.

```bash
docker compose exec -T postgres psql -U platform -d platform -c "<query>"
```

(`-T` disables pseudo-TTY allocation so output isn't garbled when run non-interactively.)

---

## Useful queries

**Modules** (`packages/db/migrations/0014_modules.sql` — platform-wide, no `tenant_id`):

```sql
SELECT slug, name, version, is_system, min_plan FROM modules ORDER BY slug;
```

**Entity types** (`tenant_id NULL` = system/template row visible to every tenant, per ADR-007):

```sql
SELECT id, tenant_id, name, plural, module_id FROM entity_types ORDER BY tenant_id NULLS FIRST, name;
```

**Workflows + their entity type**:

```sql
SELECT w.id, w.name, w.tenant_id, w.initial_state, et.name AS entity_type
FROM workflows w JOIN entity_types et ON et.id = w.entity_type_id
ORDER BY w.tenant_id NULLS FIRST, w.name;
```

**States + transitions for one workflow** (swap `<workflow_id>`):

```sql
SELECT name, label, is_terminal, sla_hours, sort_order
FROM workflow_states WHERE workflow_id = '<workflow_id>' ORDER BY sort_order;

SELECT from_state, to_state, label, allowed_roles, requires_comment
FROM workflow_transitions WHERE workflow_id = '<workflow_id>';
```

**Automation rules** (`packages/db/migrations/0000_initial_schema.sql`):

```sql
SELECT id, tenant_id, name, trigger_event, is_active FROM automation_rules ORDER BY tenant_id, name;
```

**Connectors** (`packages/db/migrations/0056_connector_definitions.sql` — platform-wide catalog):

```sql
SELECT slug, name, version, category, is_visible FROM connector_definitions ORDER BY category, slug;
```

**Plugins** (`packages/db/migrations/0059_plugin_system.sql` — platform-wide catalog):

```sql
SELECT slug, name, version, category, trust_tier FROM plugin_definitions ORDER BY category, slug;
```

---

## Notes

- These table shapes can drift — if a query errors on a missing/renamed column, that's a
  signal the schema moved since this skill was written; check the migration file named above
  rather than assuming the skill is wrong.
- `workflow_states`/`workflow_transitions` gained a denormalized `tenant_id` column in
  migration `0037` (ADR-007) for RLS — it's not shown in the original `0000_initial_schema.sql`
  block, only in the later ALTER.
- For a full-text/exploratory question ("does anything like X already exist"), grep
  `modules/**/*.sql` and `packages/db/migrations/*.sql` too — this skill covers structured
  lookups once you know the table, not fuzzy search.
