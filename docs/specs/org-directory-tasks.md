# Implementation Plan: Org Directory

**Spec:** docs/specs/org-directory.md
**Generated:** 2026-09-29
**Status:** not started

---

## Phase 1 — Core Domain (schema, importer, tree-build algorithm)

**Goal:** Org tree can be built and stored per-tenant from an auth-provider pull, with all
fallback/cycle/reparent logic correct in isolation (no API/UI yet).
**Gate:** all unit tests pass → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                        | requirement        | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| T1: New `packages/org-directory` package (depends on `db` + `auth` only; no `packages/teams` dependency)                                                                                                                                                                                                                                                                    | R1, R10            | todo   |
| T2: Auth-provider metadata read in `packages/auth/src/zitadel-management.ts` for exact keys `manager_id`/`department`, reusing existing per-tenant cache/single-flight pattern                                                                                                                                                                                              | R2                 | todo   |
| T3: Schema — org tree tables: employee node table, parent-link, prior-tree retention (for R5's diff), sync-run/status table. Tenant-scoped, RLS, indexes per db-conventions.md                                                                                                                                                                                              | R1, R2, R5         | todo   |
| T8: Module seed (`modules/org-directory` stub + entity_type registration, ADR-004 config-first)                                                                                                                                                                                                                                                                             | R1                 | todo   |
| T4: `ZitadelOrgSourceImporter` implementing the `OrgSourceImporter` boundary + tree-build algorithm: (1) cycle detect+break, (2) prior-tree diff → one-hop reparent on removed manager, (3) root-attach remaining orphans, department normalize (lowercase, blank-stays-blank), root identity from `tenants.name`. Rebuild wrapped in one transaction; per-tenant sync lock | R2, R3, R4, R5, R6 | todo   |

---

## Phase 2 — Service/API Layer (sync triggers, query interface)

**Goal:** Sync runs automatically and on-demand; other engines/UI can query the tree without
ever touching the auth provider.
**Gate:** integration tests + isolation tests pass + Phase 1 gate still green

| task                                                                                                                                                                                   | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: Sync triggers — first-boot auto-seed, 24h scheduled worker job, admin-only `triggerSync` route (enforces per-tenant lock from T4, returns `already_running` shape when applicable) | R2, R7      | done   |
| T6: Query API — `getChainToRoot`, `getReportsByLevel`, `getOrgTree`, `getSyncStatus` (never calls auth provider)                                                                       | R1, R10     | done   |
| T9: Isolation tests — cross-tenant tree read blocked via real routes/query API; RLS on new tables                                                                                      | R1, R7      | done   |

---

## Phase 3 — Consumer Integration (UI, security review)

**Goal:** End users can browse/search the chart; the full surface is security-reviewed before ship.
**Gate:** §R acceptance criteria met (all R1–R10 verified end-to-end)

| task                                                                                                                                                                                                            | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: admin-ui org chart page — visual tree, depth-3 default expand, fold/unfold, search+highlight+auto-expand-ancestors, sync-status indicator, admin-only sync button, 200ms/≤500-employee interactivity target | R7, R8, R9  | done   |
| T10: `/security-review` pass — new tables, new routes, service-account credential path (mandatory per security.md)                                                                                              | all         | done   |

---

## Out-of-band (not gated, human action)

| task                                                                                                                                                                                                                 | note |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| T11: Recommend authoring an ADR for the "auth-provider-as-seed-only-source + swappable importer" pattern — reusable beyond this feature. ADRs are human-authored; not implementation work, does not block any phase. | —    |

---

## Kick-Off Prompt

```
Read docs/specs/org-directory.md and docs/specs/org-directory-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T8, T4).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
- Follow packages/db conventions: tenant_id NOT NULL, RLS, indexes, down migration,
  analytics annotation on every new CREATE TABLE
- Zero TypeScript in modules/ (ADR-004) — T8 is seed SQL only
```

---

_Backprop reminder: if any tests failed during a phase, run `/spec amend §B`. If a pattern
emerged that shouldn't repeat, run `/spec amend §V`._
