# ADR-007: RLS for entity_types / workflows / workflow_states / workflow_transitions

**Status:** Accepted.  
**Date:** 2026-07-24.  
**Deciders:** Engineering lead, Platform architect.  
**Supersedes:** —  
**Superseded by:** —

---

## Context

Filed as issue #136 during review of PR #135 (RLS role enforcement, closed #121/#122). Four tables
have no database-level tenant isolation today:

| Table                  | `tenant_id` column                                                       | RLS policy |
| ---------------------- | ------------------------------------------------------------------------ | ---------- |
| `entity_types`         | nullable (`NULL` = system/template)                                      | none       |
| `workflows`            | nullable (`NULL` = system/template)                                      | none       |
| `workflow_states`      | **no column** — reachable only via `workflow_id` → `workflows.tenant_id` | none       |
| `workflow_transitions` | **no column** — reachable only via `workflow_id` → `workflows.tenant_id` | none       |

This predates PR #135 — RLS was bypassed everywhere via the superuser connection before that fix,
so these four tables never had real row-level protection. PR #135's grant migration
(`0022_app_user_rls_grants.sql`) grants `app_user` table-level DML on these tables (required so
existing routes keep working under the new `app_user` role) — that is a table-level grant, not
row-level, and does not add or worsen isolation either way.

Today, isolation on these four tables is enforced **solely** by explicit application-layer
ownership checks in `packages/workflow-engine/src/workflow-crud.ts`:

- `visibleTo(tenantId)` — a Drizzle `or()` filter used on every read query, allowing rows where
  `tenant_id = current tenant` OR `tenant_id IS NULL` (system/template rows readable by all
  tenants) — see e.g. `workflow-crud.ts:78,171,206,238,249,327,404`.
- `assertWorkflowOwned(db, tenantId, workflowId, caller)` — an explicit ownership check called at
  the top of every mutation function (`workflow-crud.ts:440`, called from lines 475/507/540/593/
  626/668) that throws before any write proceeds if the workflow isn't owned by the caller's
  tenant.

There is no database-level second line of defense: a bug in a new route that forgets to call
`assertWorkflowOwned` (or that queries `workflow_states`/`workflow_transitions` directly, bypassing
`workflow-crud.ts` entirely) would have no RLS backstop, unlike every other tenant-scoped table in
the platform (see `.claude/rules/db-conventions.md`'s "two layers — both are required" rule, which
these four tables are the sole exception to today).

### Two complications

1. **`workflow_states` / `workflow_transitions` have no `tenant_id` column at all.** A policy can't
   filter on `tenant_id` directly — it needs either (a) a new denormalized `tenant_id` column,
   backfilled from `workflow_id` → `workflows.tenant_id`, or (b) a correlated subquery against
   `workflows` (materially slower — subqueries in RLS policies aren't index-friendly the way a
   direct column filter is).
2. **`entity_types` / `workflows` mix `NULL`-tenant (system/template) rows with per-tenant rows in
   the same table.** The policy must allow every tenant to read `NULL`-tenant rows (so all tenants
   see the built-in module templates) while still blocking cross-tenant reads/writes of real
   per-tenant rows.

### Existing precedent

Both complications already have an established, working precedent in
`packages/db/migrations/0001_rls_and_tenancy.sql`, applied when `workflow_events` and
`entity_fields` needed the same treatment:

```sql
-- Complication 1 precedent: workflow_events had no tenant_id column either.
ALTER TABLE workflow_events ADD COLUMN tenant_id UUID NOT NULL;
CREATE INDEX workflow_events_tenant_instance_idx ON workflow_events (tenant_id, instance_id);
```

```sql
-- Complication 2 precedent: entity_fields already mixes NULL-tenant (system field
-- definitions) and per-tenant rows.
ALTER TABLE entity_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_field_read ON entity_fields
  FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY tenant_field_write ON entity_fields
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);
```

The write policy does not include the `tenant_id IS NULL` clause — `app_user` can never write a
system/template row, only read it. `entity_types`/`workflows` copy this exact shape (see
Decision). No table in this codebase uses `FORCE ROW LEVEL SECURITY`; enforcement instead comes
from `withTenantContext`'s `SET LOCAL ROLE app_user` switching off the bypassing superuser role
(`.claude/rules/db-conventions.md`, issue #121) — `FORCE` is not this codebase's pattern and isn't
needed here.

`workflow_events`'s migration ran before that table had production data ("Fresh schema — no
backfill needed"). `workflow_states`/`workflow_transitions` do have data today, so this ADR's
migration needs a backfill step that precedent didn't (see "Backfill safety" under Consequences).

**Alternative considered and rejected: a sentinel "system tenant" row instead of `NULL`.** Some
multi-tenant Postgres systems avoid `tenant_id IS NULL` entirely — e.g. a reserved system-tenant
UUID referenced via a normal `NOT NULL` FK — because `NULL` interacts awkwardly with unique
constraints (`NULL <> NULL`, so a unique index doesn't stop two "system" rows sharing a name) and
adds an `IS NULL OR` branch to every policy. Not adopted here: `NULL` is the working, tested
precedent already in this codebase (`entity_fields`, live since migration 0001, actively exercised
by the issue #168 isolation tests), and switching now would be a bigger, riskier change to a
pattern with no reported incidents — out of scope for an RLS-hardening ADR filed as issue #136.

---

## Evaluated Options

The `entity_types`/`workflows` policy shape is settled by precedent (above) — no real alternative
exists there. `workflow_states`/`workflow_transitions` is the one place with a genuine choice,
because unlike the other two tables, there's no existing data indicating whether a NULL-tenant row
will ever be needed.

### Option A — `NOT NULL` tenant_id, `entity_instances`-style policy ✅ Selected

`workflow_states`/`workflow_transitions` get a plain `tenant_id UUID NOT NULL` column and the same
policy shape as `entity_instances` (no NULL-tenant read branch).

**Why this is safe:** `workflow-crud.ts`'s `createWorkflow(db, tenantId: string, ...)` takes a
non-nullable `tenantId` and always inserts a concrete value — there is no application code path
that can create a NULL-tenant workflow, and every `modules/*/seed/002_workflow.sql` file confirms
none does. This holds even in the one scenario designed to stress it: the issue #168 isolation
tests (`apps/api/tests/isolation/workflow-engine.isolation.test.ts`, ~lines 385-460) have two
different tenants each create a workflow against the _same shared, NULL-tenant `entity_type`_ — and
in both cases the resulting `workflows` row still gets a concrete `tenantId`
(`expect(workflow.tenantId).toBe(...)`). A shared/template entity type never implies a
shared/template workflow, and `workflow_states`/`workflow_transitions` only ever hang off a
workflow.

Separately, the accepted `ADR-001-multitenancy.md` (§7, Open Question MT-04) already designates a
**separate `workflow_templates` table** — never built — as the intended home for shareable,
versioned platform-wide workflow templates. The `isNull(workflows.tenantId)` branch in
`workflow-crud.ts:78-80,404-407` ("system workflow, tenant_id = null") is speculative code that
predates or diverged from that decision; it isn't evidence that NULL-tenant workflows are a
planned feature.

**Verdict:** Selected. Matches all current data and code guarantees, matches the platform's own
accepted multitenancy ADR, and keeps this migration scoped to what issue #136 asked for (RLS
hardening, not a new templating feature).

### Option B — nullable tenant_id, `entity_fields`-style policy

Same columns, but nullable, with the `entity_fields`-style read/write pair.

**Verdict:** Rejected (for now). Future-proofs against template workflows that don't currently
exist and aren't structurally reachable, at the cost of formalizing a code path
(`isNull(workflows.tenantId)`) that ADR-001 didn't intend as the long-term template mechanism. If a
human confirms template workflows are near-term roadmap, revisit — see "Next steps."

### Option C — build `workflow_templates` first, then this ADR

Implement the `workflow_templates` table ADR-001 originally specified (resolving MT-04), then do
this ADR's migration with guaranteed-clean `NOT NULL` semantics and no ambiguity.

**Verdict:** Rejected (for now). Architecturally the cleanest option, but a scope expansion this
ADR shouldn't absorb — new table, new engine support, new UI/API surface. Should be its own
initiative if the org wants `workflow_templates` at all, not a prerequisite bolted onto RLS
hardening.

---

## Decision

**Adopt Option A.** `workflow_states`/`workflow_transitions` get `tenant_id UUID NOT NULL`, backfilled
from `workflow_id` → `workflows.tenant_id`, with an `entity_instances`-style policy pair.
`entity_types`/`workflows` get the `entity_fields`-style nullable read/write pair verbatim (policy
names swapped per table).

### Implementation specification

1. **`entity_types`, `workflows`:**

   ```sql
   ALTER TABLE entity_types ENABLE ROW LEVEL SECURITY;

   CREATE POLICY tenant_type_read ON entity_types
     FOR SELECT
     USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::UUID);

   CREATE POLICY tenant_type_write ON entity_types
     FOR ALL
     USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

   -- same shape for `workflows` (tenant_workflow_read / tenant_workflow_write)
   ```

2. **`workflow_states`, `workflow_transitions`:** add the column, backfill, then a plain `SET NOT
NULL` — **not** the `NOT VALID`/`VALIDATE CONSTRAINT` low-lock pattern the original version of
   this ADR specified. That pattern is standard practice for adding `NOT NULL` to a live table on
   plain Postgres (GitLab/Citus use it), but it doesn't help here: this repo's migration runner
   (`drizzle-orm/postgres-js`'s `PgDialect.migrate`) wraps _every pending migration_ into one
   `session.transaction(...)` call, not one transaction per file. The `ADD COLUMN` statement below
   already takes an `ACCESS EXCLUSIVE` lock that Postgres holds for the rest of that transaction
   regardless — `VALIDATE CONSTRAINT`'s weaker `SHARE UPDATE EXCLUSIVE` requirement buys nothing
   once a stronger lock is already held, and the extra constraint create/drop only adds work under
   that same lock. Found via adversarial review after the initial implementation; corrected here
   and in the shipped migration (`packages/db/migrations/0037_rls_workflow_config_tables.sql`):

   ```sql
   ALTER TABLE workflow_states ADD COLUMN tenant_id UUID;

   UPDATE workflow_states ws SET tenant_id = w.tenant_id
     FROM workflows w WHERE w.id = ws.workflow_id;

   ALTER TABLE workflow_states ALTER COLUMN tenant_id SET NOT NULL;

   CREATE INDEX workflow_states_tenant_idx ON workflow_states (tenant_id);
   ALTER TABLE workflow_states ENABLE ROW LEVEL SECURITY;

   CREATE POLICY tenant_read ON workflow_states
     FOR SELECT
     USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

   CREATE POLICY tenant_write ON workflow_states
     FOR ALL
     USING      (tenant_id = current_setting('app.tenant_id', true)::UUID)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::UUID);

   -- same steps for workflow_transitions
   ```

3. Keep the existing `visibleTo`/`assertWorkflowOwned` application-layer checks in
   `workflow-crud.ts` **unchanged** — RLS is a second line of defense, not a replacement (same
   "defense-in-depth, not alternatives" rule as every other table per `db-conventions.md`).

4. Isolation tests travel with the migration, per `db-conventions.md`'s mandate — new
   cross-tenant-access-attempt tests in `apps/api/tests/isolation/` for all four tables, following
   the existing pattern (e.g. `workflow-engine.isolation.test.ts`'s #168 tests added in PR #172),
   **plus** a targeted test for `apps/worker/src/tenant-purge.ts`'s workflow-state/transition
   deletion path under the new policies (see Consequences — that file's header comment goes stale
   the moment this ships).

### Verified safe: nothing reads these tables outside tenant context

`packages/db/migrations/0006_remove_internal_table_rls.sql` is a real precedent for RLS silently
breaking a cross-tenant process: RLS was enabled on `outbox_events`/`dead_letter_events`, then had
to be reverted because a worker polls across all tenants with no `app.tenant_id` set, and RLS
silently returned zero rows instead of erroring. Checked every place that touches
`workflows`/`workflow_states`/`workflow_transitions`/`entity_types` for the same risk:

- `apps/worker/src/sla-scheduler.ts` / `sla-breacher.ts` — never touch these four tables.
- `apps/worker/src/tenant-purge.ts` — the only worker that touches them, deleting
  `workflowTransitions`/`workflowStates` by `inArray(workflowId, wfIds)` during tenant purge. Runs
  inside `withTenantContext(tenantId, ...)`, so `app.tenant_id` is set and the connection is
  already `app_user` — safe. Its header comment (`tenant-purge.ts:16-17`) currently lists these two
  tables as "without RLS," which becomes false the moment this ships (see Next Steps).
- `apps/api/src/services/module-service.ts` — the primary write path for all four tables in normal
  operation (module installation). `installModule()` runs every seed SQL file through
  `executeRawInTenantContext(tenantId, sql)` (`module-service.ts:235`), which sets `SET LOCAL ROLE
app_user` and `app.tenant_id` before executing; seed SQL's `{TENANT_ID}` substitution means every
  insert has a concrete tenant value. Safe.

---

## Consequences

### Positive

These four tables gain the same defense-in-depth RLS backstop every other tenant-scoped table
already has; a future route that forgets an explicit tenant filter or an `assertWorkflowOwned` call
is now caught at the database layer instead of silently leaking data.

### Negative

- Two new columns, two backfills, four new policy pairs, and isolation test additions — a real
  migration PR, not a one-line fix. `workflow_states`/`workflow_transitions` gain a small amount of
  denormalization (duplicating `tenant_id` from the parent `workflows` row) in exchange for RLS
  being expressible as a direct column filter instead of a slower correlated subquery.
- `apps/worker/src/tenant-purge.ts`'s header comment will be stale the moment this ships and must
  be updated in the same PR (see Next Steps).
- Choosing Option A leaves `workflow-crud.ts`'s `isNull(workflows.tenantId)` "system workflow" code
  path looking intentional when it's actually vestigial relative to ADR-001's `workflow_templates`
  design. Worth its own follow-up cleanup issue (non-blocking) so it doesn't get mistaken for a
  supported feature later.

### Backfill safety

Dev-database row counts are trivial: 22 `workflow_states`, 20 `workflow_transitions`. Structurally
these tables scale with (tenant × entity type × workflow), not with entity instances, so they
should stay small in production too — but this is dev evidence, not a production measurement (see
Open Questions). `packages/db/migrations/0024_entity_instances_search_vector.sql` establishes this
repo's convention for exactly this situation: accept row-level locking for a live-data backfill at
pilot scale, with an explicit maintenance-window fallback if a table turns out larger than
expected.

This ADR follows that convention for the `UPDATE` backfill step. The `SET NOT NULL` step gets
no special exemption from this — per the correction in the Implementation specification above,
it runs under the same already-held `ACCESS EXCLUSIVE` lock as the rest of the migration batch,
not a lighter one. The maintenance-window fallback below is really about the `UPDATE` backfill's
row-level lock duration at scale, not about protecting `SET NOT NULL` specifically.

---

## Open Questions

| ID   | Question                                                                                                              | Notes                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | What are the actual `workflow_states`/`workflow_transitions` row counts in staging/production?                        | Dev shows 22/20 (trivial). Confirm before running; fall back to a maintenance window (per the `0024` precedent) only if counts are materially larger. |
| OQ-2 | Does this keep its "before Phase 3" priority relative to the rest of the pre-Phase-3 hardening backlog (`CLAUDE.md`)? | Pure prioritization call — not resolvable by research.                                                                                                |

---

## Next steps if accepted

1. A human moves this file to `docs/decisions/ADR-007-rls-workflow-config-tables.md` (or edits it
   first) and updates `CLAUDE.md`'s ADR reference list.
2. Implement as a single migration (new file, e.g.
   `packages/db/migrations/00XX_rls_workflow_config_tables.sql`) following the specification above,
   with the down-migration comment block per `db-conventions.md`'s migration checklist.
3. Add isolation tests for all four tables, plus the `tenant-purge.ts` regression test, in the
   same PR.
4. Update `apps/worker/src/tenant-purge.ts`'s header comment (lines 16-17) to remove
   `workflow_states`/`workflow_transitions` from the "tables without RLS" list.
5. Confirm production row counts (OQ-1) before running against a real environment.
