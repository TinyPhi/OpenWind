# RLS for Workflow Config Tables

> Add database-level RLS to `entity_types`, `workflows`, `workflow_states`, `workflow_transitions`
> — closes the sole remaining gap in the platform's two-layer tenant isolation guarantee.
> Pre-Phase-3 hardening (issue #136).

status: draft
created: 2026-07-24
updated: 2026-07-24
reviewed: 2026-07-24 (ADR-007 accepted)
gh: #136

---

## §G Goal

- `entity_types`, `workflows`, `workflow_states`, `workflow_transitions` all enforce tenant
  isolation at the database layer, matching every other tenant-scoped table
- No existing legitimate cross-tenant/system read path breaks (module install, tenant purge,
  shared/template `entity_types`)
- Application-layer checks (`visibleTo`, `assertWorkflowOwned`) remain as defense-in-depth,
  unchanged

---

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack            | PostgreSQL RLS, Drizzle migrations (`packages/db/migrations`), drizzle-orm/postgres-js migrator                                                                                                                                                                                                                              |
| decision source  | `docs/decisions/ADR-007-rls-workflow-config-tables.md` (accepted 2026-07-24) — this spec implements it verbatim; no new design decisions belong here                                                                                                                                                                         |
| out of scope     | `workflow_templates` table (ADR Option C, rejected); nullable `workflow_states`/`workflow_transitions` shape (ADR Option B, rejected); any change to `workflow-crud.ts`'s `visibleTo`/`assertWorkflowOwned`; cleanup of the vestigial `isNull(workflows.tenantId)` code path (separate follow-up issue per ADR Consequences) |
| gate             | Production row counts for `workflow_states`/`workflow_transitions` must be confirmed before running this migration against a real environment (ADR Open Question OQ-1) — this spec covers writing and testing the migration, not the production rollout decision                                                             |
| migration runner | Migrations run in a single transaction (drizzle-orm/postgres-js migrator) — `CREATE INDEX CONCURRENTLY` is unavailable; `NOT VALID` / `VALIDATE CONSTRAINT` works fine inside a transaction                                                                                                                                  |

---

## §I Interfaces

### Migration SQL

Exact SQL is specified in `docs/decisions/ADR-007-rls-workflow-config-tables.md`'s "Implementation
specification" section — both blocks (entity_types/workflows policy pair, and
workflow_states/workflow_transitions column+backfill+NOT VALID/VALIDATE CONSTRAINT/SET NOT
NULL+index+policy pair) are copied verbatim into the new migration file, not re-derived.

### Files touched

- New: `packages/db/migrations/00XX_rls_workflow_config_tables.sql` (number = next available in
  sequence)
- `apps/worker/src/tenant-purge.ts` — header comment update only (lines 16-17); no logic change
- New/updated: `apps/api/tests/isolation/*.isolation.test.ts` — cross-tenant tests for all four
  tables
- New: tenant-purge regression test covering the workflow-state/transition deletion path
- `CLAUDE.md` — add ADR-007 to the reference docs list (doc-only; may be its own tiny commit,
  separate from the migration PR)

---

## §R Requirements

R1: `entity_types` and `workflows` enforce RLS with the `entity_fields`-style nullable-tenant read
policy.
✓ RLS enabled on both tables
✓ A tenant can read a NULL-tenant (system/template) row of either table
✓ A tenant can read its own rows
✓ A tenant cannot read another tenant's concrete-tenant row
✓ `app_user` cannot write (insert/update/delete) a NULL-tenant row via a normal request
✓ `app_user` cannot write a row into another tenant's `tenant_id`

R2: `workflow_states` and `workflow_transitions` get a `NOT NULL` `tenant_id` column, correctly
backfilled, with `entity_instances`-style RLS.
✓ Migration adds `tenant_id UUID NOT NULL` to both tables, backfilled from
`workflow_id` → `workflows.tenant_id`
✓ Backfill correctness: every pre-existing row's `tenant_id` equals its parent workflow's
`tenant_id` after migration
✓ `tenant_id` column uses the `NOT VALID` → `VALIDATE CONSTRAINT` → `SET NOT NULL` sequence, not a
direct `ALTER COLUMN SET NOT NULL`
✓ Index on `tenant_id` for both tables
✓ RLS enabled; a tenant can only read/write its own rows
✓ Down-migration documented per `db-conventions.md`

R3: Existing legitimate paths keep working under the new RLS.
✓ Module install (`ModuleService.installModule`) still succeeds for every module's seed SQL
(`entity_types`/`workflows`/`workflow_states`/`workflow_transitions` inserts)
✓ Tenant purge (`tenant-purge.ts`) still deletes `workflowStates`/`workflowTransitions`/`workflows`
correctly for a purged tenant
✓ `workflow-crud.ts`'s `visibleTo`/`assertWorkflowOwned` application-layer checks are untouched and
their existing tests still pass

R4: Isolation tests prove cross-tenant access is blocked at the DB layer for all four tables.
✓ New isolation tests attempt cross-tenant read/write on `entity_types`, `workflows`,
`workflow_states`, `workflow_transitions` and are blocked
✓ Existing isolation tests (e.g. `workflow-engine.isolation.test.ts`'s #168 tests) still pass
unchanged

R5: `tenant-purge.ts`'s documentation matches reality after this ships.
✓ Header comment (lines 16-17) no longer lists `workflow_states`/`workflow_transitions` as tables
without RLS
✓ A regression test exercises tenant-purge's workflow-state/transition deletion path under the new
RLS policies and passes

---

## §V Invariants

- RLS + explicit tenant filters are both required (defense-in-depth) — never remove
  application-layer checks on the assumption RLS alone suffices
- `workflow_states`/`workflow_transitions.tenant_id` is `NOT NULL` — no code path may ever insert a
  NULL value there (matches `createWorkflow`'s structural guarantee, per ADR-007)
- `entity_types`/`workflows` write policies never allow `app_user` to write a NULL-tenant row

---

## §T Tasks

Single phase — this is a contained, already-decided migration (ADR-007 is accepted), not
multi-layer feature work.

| id  | task                                                                                                                                                            | phase | status | depends |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migration: `entity_types` + `workflows` RLS (`entity_fields`-style read/write pair)                                                                             | 1     | todo   | —       |
| T2  | Migration: `workflow_states` + `workflow_transitions` — add `tenant_id` column, backfill, `NOT VALID`/`VALIDATE CONSTRAINT`/`SET NOT NULL`, index, RLS policies | 1     | todo   | —       |
| T3  | Down-migration comment block + analytics annotation for the new migration file                                                                                  | 1     | todo   | T1,T2   |
| T4  | Update `tenant-purge.ts` header comment (lines 16-17)                                                                                                           | 1     | todo   | T2      |
| T5  | Isolation tests: cross-tenant read/write blocked for all four tables                                                                                            | 1     | todo   | T1,T2   |
| T6  | Regression test: tenant-purge workflow-state/transition deletion path under new RLS                                                                             | 1     | todo   | T2,T4   |
| T7  | Run full exit condition (typecheck, lint, test, test:isolation); fix any breakage in module install / tenant purge / existing isolation tests                   | 1     | todo   | T1-T6   |
| T8  | `CLAUDE.md`: add ADR-007 to reference docs list (doc-only, can commit separately)                                                                               | 1     | todo   | —       |

phase gate: all four (`typecheck`, `lint`, `test`, `test:isolation`) green before shipping

---

## §B Bugs / Backprop Log

(empty — to be filled during implementation)
