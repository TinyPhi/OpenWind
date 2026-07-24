---
paths: ["packages/db/**", "tests/isolation/**", "**/*.sql", "**/migrations/**"]
---

# Database Conventions — OpenWind Platform

---

## Drizzle is the only query layer

No raw SQL in application code except:

1. Migration files in `packages/db/migrations/`
2. Explicitly performance-critical hot paths with a comment explaining why Drizzle was insufficient

Never instantiate a DB client. Always import from `@platform/db`.

**Tenant isolation uses two layers — both are required:**

1. **Explicit `WHERE tenant_id = ?` filters** in every engine query. These are the primary guard and must not be removed.
2. **RLS via `set_config('app.tenant_id', …)`** set by `withTenantContext`. This is the second line of defence.

`withTenantContext` and `executeRawInTenantContext` issue `SET LOCAL ROLE app_user` before setting the GUC (#121), so RLS is enforced even when `DATABASE_URL` connects as a superuser (e.g. CI's `platform` role) — `SET LOCAL ROLE` inside the transaction switches to the non-superuser, non-`BYPASSRLS` `app_user` role for the duration of that transaction. RLS and explicit `WHERE tenant_id` filters are both required — defense-in-depth, not alternatives. Never remove explicit tenant filters on the assumption that RLS alone is sufficient. `withTenantAndUserContext` (used for saved views) additionally sets `app.user_id` and is the pattern to follow for user-scoped resources.

`entity_types` and `workflows` have `tenant_id` nullable — `NULL` denotes system/template rows visible to every tenant, enforced by an `entity_fields`-style RLS policy pair (`tenant_id IS NULL OR tenant_id = current_setting(...)` for reads, no `IS NULL` branch for writes) as of ADR-007 (migration 0037). `workflow_states`/`workflow_transitions` gained a denormalized `tenant_id UUID NOT NULL` column (backfilled from `workflow_id` → `workflows.tenant_id`) and a standard `entity_instances`-style RLS pair in the same migration — see `docs/decisions/ADR-007-rls-workflow-config-tables.md` for why they don't need the nullable shape. The explicit ownership checks in `packages/workflow-engine` (`assertWorkflowOwned`/`visibleTo`) remain unchanged and are still required — RLS on these four tables is the second layer, not a replacement.

---

## Every tenant-scoped table requires

```sql
tenant_id UUID NOT NULL REFERENCES tenants(id)
-- RLS policy — see ADR-001
-- index on tenant_id
-- composite index for the primary query pattern
```

Missing any of these is a PR blocker.

---

## Migration files

Numbered SQL files only — never `drizzle push`:

```
packages/db/migrations/
  0001_initial_schema.sql
  0002_add_workflow_events.sql
```

Each migration file must include:

- A **down migration** as a comment block at the top
- `-- analytics: excluded (reason)` OR `-- analytics: included(col1,col2,...)` on every `CREATE TABLE`
- Runs in a transaction — partial migrations are a production incident

Migration PR checklist:

- [ ] `tenant_id NOT NULL` on all new tenant-scoped tables
- [ ] RLS policy for each new table
- [ ] Index on `tenant_id`
- [ ] Index on primary query pattern
- [ ] Down migration (rollback SQL) at the top as a comment
- [ ] Analytics annotation on every `CREATE TABLE`

---

## Isolation tests travel with every new table

Adding a new tenant-scoped table? Add isolation tests in `tests/isolation/` in the
same PR. The isolation suite attempts cross-tenant access via every public API surface.

Run: `pnpm test:isolation` (requires Docker/OrbStack stack).
