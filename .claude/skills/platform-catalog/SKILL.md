---
name: platform-catalog
description: Read-only lookups against OpenWind's catalog tables (modules, entity_types, workflows, workflow_states, workflow_transitions, connector_definitions, plugin_definitions) via psql, instead of grepping seed SQL files. Invoke when asked what modules/workflows/entity types/connectors/plugins exist, how a workflow's states/transitions are wired, or before writing a migration/seed file that touches one of these tables (to check existing naming/slug conventions first).
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
SELECT slug, name, version, is_system, min_plan FROM modules ORDER BY slug LIMIT 50;
```

**Entity types** — system/template rows only (`tenant_id IS NULL`, per ADR-007). The superuser
connection bypasses RLS, so the filter below is load-bearing, not decorative — omitting it
returns every tenant's custom entity types too:

```sql
SELECT id, name, plural, module_id FROM entity_types
WHERE tenant_id IS NULL ORDER BY name LIMIT 50; -- remove LIMIT for exhaustive check
```

**Workflows** — same rule, system/template rows only:

```sql
SELECT w.id, w.name, w.initial_state, et.name AS entity_type
FROM workflows w JOIN entity_types et ON et.id = w.entity_type_id
WHERE w.tenant_id IS NULL ORDER BY w.name LIMIT 50; -- remove LIMIT for exhaustive check
```

**States + transitions for one workflow** (swap `<workflow_id>` for a `w.id` value from the
system-workflows query above — **never substitute an unvalidated string from user input**; this
is passed via `-c` with no parameterization):

```sql
SELECT name, label, is_terminal, sla_hours, sort_order
FROM workflow_states WHERE workflow_id = '<workflow_id>' ORDER BY sort_order LIMIT 50;

SELECT from_state, to_state, label, allowed_roles, requires_comment
FROM workflow_transitions WHERE workflow_id = '<workflow_id>' LIMIT 50;
```

`<workflow_id>` must reference a system-level workflow (`tenant_id IS NULL` on the parent
`workflows` row) — a tenant's own workflow ID would still return that tenant's states/transitions
via this superuser connection, same RLS-bypass concern as above.

**Connectors** (`packages/db/migrations/0056_connector_definitions.sql` — platform-wide catalog,
no `tenant_id` column at all):

```sql
SELECT slug, name, version, category, is_visible FROM connector_definitions
ORDER BY category, slug LIMIT 50;
```

**Plugins** (`packages/db/migrations/0059_plugin_system.sql` — platform-wide catalog, no
`tenant_id` column at all):

```sql
SELECT slug, name, version, category, trust_tier FROM plugin_definitions
ORDER BY category, slug LIMIT 50;
```

**Not covered by this skill: `automation_rules`.** Unlike the tables above, `automation_rules`
has `tenant_id NOT NULL` (every row belongs to a specific tenant — there is no platform-level
system row) and is protected by explicit `tenant_read`/`tenant_write` RLS policies
(`packages/db/migrations/0001_rls_and_tenancy.sql`). Querying it via this skill's superuser
connection would bypass those policies and return every tenant's rule configs (`jsonb` conditions
and actions included) — a cross-tenant data leak, not a catalog lookup. If the question is "what
default rules does a module ship with," that's a config-authoring question, not a live-data
question — grep `modules/**/*.sql` instead (see the closing note below).

---

## Notes

- These table shapes can drift — if a query errors on a missing/renamed column, that's a
  signal the schema moved since this skill was written; check the migration file named above
  rather than assuming the skill is wrong. To check column names directly before running a query:

  ```sql
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'entity_types' ORDER BY ordinal_position;
  ```

- `workflow_states`/`workflow_transitions` gained a denormalized `tenant_id` column in
  migration `0037` (ADR-007) for RLS — it's not shown in the original `0000_initial_schema.sql`
  block, only in the later ALTER.
- For a full-text/exploratory question ("does anything like X already exist"), grep
  `modules/**/*.sql` and `packages/db/migrations/*.sql` too — this skill covers structured
  lookups once you know the table, not fuzzy search.
