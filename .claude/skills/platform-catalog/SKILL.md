---
name: platform-catalog
description: Read-only lookups against OpenWind's genuinely platform-wide catalog tables (modules, connector_definitions, plugin_definitions) via psql, instead of grepping seed SQL files. Invoke when asked what modules/connectors/plugins exist, or before writing a migration/seed file that touches one of these tables (to check existing naming/slug conventions first).
---

# Skill: platform-catalog

Fast, read-only answers to "what already exists" questions about OpenWind's config-first
catalog — without grepping every `packages/db/migrations/*.sql` and `modules/**/*.sql` file
by hand. This is a lookup tool, not a data-modification path.

---

## When to use

- "What modules/connectors/plugins does the platform have?"
- Before writing a new module seed, migration, or workflow config — to check existing slugs,
  naming conventions, or whether something similar already exists (ADR-004 config-first design).
- Answering questions about the module/connector/plugin catalog pattern (ADR-005/ADR-009/ADR-011).

Not for: entity types, workflows, workflow states/transitions, or any other tenant-owned data
(entity instances, tickets, tenant records) — see "Not covered by this skill" below for why, and
grep `modules/**/*.sql` instead (see the closing note). Not for writes — this skill is `SELECT`
only; use a migration or seed file to change catalog data.

---

## Connecting

Requires the dev stack running (`docker compose up -d`). Run queries against the `postgres`
service directly, as the `platform` superuser — this bypasses RLS, which is fine here because
`modules`, `connector_definitions`, and `plugin_definitions` are genuinely platform-wide: none of
them has a `tenant_id` column at all. Never use this superuser connection pattern to look at
tenant-owned data — that needs the app's `withTenantContext` role-switch, not raw psql.

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

**Not covered by this skill: `entity_types`, `workflows`, `workflow_states`, `workflow_transitions`.**
ADR-007's RLS policy is written to allow `tenant_id IS NULL` system/template rows in
`entity_types`/`workflows` (all tenants could read one, if it existed), but nothing in this
codebase ever creates one: every `modules/*/seed/*.sql` file inserts these rows with a concrete
`{TENANT_ID}` (confirmed across all 8 modules), no migration inserts into either table, and
`createWorkflow()` requires a non-nullable `tenantId` — ADR-007 states directly that "there is no
application code path that can create a NULL-tenant workflow." (The one NULL-tenant `entity_types`
row that ever exists anywhere in this codebase is a throwaway fixture the issue #168 isolation
test creates and deletes within a single test — not real catalog data.) A `WHERE tenant_id IS
NULL` query against either table returns zero rows, always, against any real dev database.
`workflow_states`/`workflow_transitions` only ever hang off a real tenant's workflow, so the same
applies transitively. If the question is "what entity types/workflow states does a module ship
with," that's a config-authoring question, not a live-data question — grep `modules/**/*.sql`
instead (see the closing note below). To inspect a specific tenant's actual installed entity
types/workflows, use the app's own tenant-scoped tooling, not this skill.

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
  WHERE table_name = 'modules' ORDER BY ordinal_position;
  ```

- For a full-text/exploratory question ("does anything like X already exist"), grep
  `modules/**/*.sql` and `packages/db/migrations/*.sql` too — this skill covers structured
  lookups once you know the table, not fuzzy search.
