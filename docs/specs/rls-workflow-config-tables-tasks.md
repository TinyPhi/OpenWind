# Implementation Plan: RLS for Workflow Config Tables

**Spec:** docs/specs/rls-workflow-config-tables.md
**Generated:** 2026-07-24
**Status:** not started

---

## Phase 1 — Migration + Tests (single phase — contained, already-decided per ADR-007)

**Goal:** `entity_types`, `workflows`, `workflow_states`, `workflow_transitions` all enforce tenant
isolation at the database layer, with every existing legitimate path (module install, tenant
purge, app-layer ownership checks) still passing.
**Gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation` all green.

| task                                                                                                                                                                                                        | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Migration — `entity_types` + `workflows` RLS (`entity_fields`-style read/write pair, verbatim from ADR-007)                                                                                             | R1          | todo   |
| T2: Migration — `workflow_states` + `workflow_transitions`: add `tenant_id` column, backfill from `workflows.tenant_id`, `NOT VALID`/`VALIDATE CONSTRAINT`/`SET NOT NULL`, index, RLS policies              | R2          | todo   |
| T3: Down-migration comment block + analytics annotation on the new migration file, per `db-conventions.md`'s migration checklist                                                                            | R2          | todo   |
| T4: Update `apps/worker/src/tenant-purge.ts` header comment (lines 16-17) — remove `workflow_states`/`workflow_transitions` from the "no RLS" list                                                          | R5          | todo   |
| T5: Isolation tests — cross-tenant read/write blocked on all four tables (`apps/api/tests/isolation/`)                                                                                                      | R4          | todo   |
| T6: Regression test — `tenant-purge.ts`'s workflow-state/transition deletion path under the new RLS policies                                                                                                | R5          | todo   |
| T7: Verify R3 directly — module install (`ModuleService.installModule`) and tenant purge still succeed end-to-end; existing isolation tests (issue #168) and `workflow-crud.ts` tests unchanged and passing | R3          | todo   |
| T8: `CLAUDE.md` — add ADR-007 to the reference docs list (doc-only; independent of T1-T7, may commit separately)                                                                                            | —           | todo   |

phase gate: all §R acceptance criteria met, exit condition green, `workflow-crud.ts` untouched

---

## Kick-Off Prompt

Copy this into your Claude Code session to start implementation:

```
Read docs/specs/rls-workflow-config-tables.md and docs/specs/rls-workflow-config-tables-tasks.md,
and docs/decisions/ADR-007-rls-workflow-config-tables.md (the accepted decision this implements).

Implement Phase 1 tasks T1-T8.

Rules:
- Copy the migration SQL from ADR-007's "Implementation specification" verbatim — do not
  re-derive it.
- Do not modify packages/workflow-engine/src/workflow-crud.ts — visibleTo/assertWorkflowOwned stay
  exactly as they are (ADR-007 Decision, item 3).
- After T1-T2 (the migration), run T5-T7's tests before considering the migration done — a
  migration without passing isolation tests is not complete per db-conventions.md.
- If a test fails, log it in the spec's §B before fixing (`/spec amend §B`).
- If you hit a decision not covered by ADR-007 or the spec, stop and ask — do not assume.
- T8 (CLAUDE.md) is independent and doc-only — fine to do first, last, or as a separate commit.
```
