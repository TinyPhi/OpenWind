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

## Cross-table FK references need an app-layer ownership check, not just a DB FK

A plain Postgres `FOREIGN KEY` constraint only guarantees the referenced row exists
_somewhere_ — it does not guarantee that row belongs to the same tenant as the row holding
the reference. Two compounding reasons this matters:

1. **FK constraint checks bypass RLS.** Postgres evaluates FK integrity as the table owner,
   not as the querying role — RLS policies never run during that check, so a same-shaped
   FK alone cannot enforce "must belong to this tenant."
2. **Some references have no table to point an FK at.** A `*_user_id` column referencing a
   Zitadel-managed identity (no local `users` table — see `packages/entity-engine`'s
   `validateUserRefs` against the `tenant_users` shadow table) or a deliberately
   FK-less column (e.g. `notification_policies.workflow_type_id`, per ADR-016) can't use a
   DB FK at all.

**The pattern**: any column that references another tenant-scoped table (or a
Zitadel-managed identity) — where that column is not itself the row's own `tenant_id` — is
validated in the application layer, before the write is issued, against the requesting
tenant. Two established implementations of this pattern exist and should be reused rather
than re-implemented per feature:

- `packages/entity-engine/src/validation/ref-validator.ts` — `validateEntityRefs`/
  `validateUserRefs`, specific to the entity engine's `entity_ref`/`user_ref` field types.
- `packages/teams/src/cross-tenant-ref-validator.ts` — `validateCrossTenantRefs` +
  `lookupValidIdsInTable`, the **generic, table-agnostic** version (docs/specs/
  oncall-routing.md R1d/T44). Prefer this one for any new cross-table reference outside the
  entity engine's own field types — e.g. `services.team_id`, `on_call_schedules.*_user_id`,
  `notification_policies.team_id`/`.workflow_type_id`, and the temporal-scheduler track's
  `schedule_rules.workflow_id` and template `team_id`/`assignee_id`/`service_id` (R10b) all
  reuse this same helper rather than each shipping their own validation function.

A rejected cross-tenant reference returns `422` (a field-level validation error), never a
raw FK-violation `500` and never a `403` (which would leak that the referenced row exists —
see `security.md`'s 404-not-403 rule, applied here as "422, not an existence leak").

---

## Isolation tests travel with every new table

Adding a new tenant-scoped table? Add isolation tests in `tests/isolation/` in the
same PR. The isolation suite attempts cross-tenant access via every public API surface.

Run: `pnpm test:isolation` (requires Docker/OrbStack stack).
