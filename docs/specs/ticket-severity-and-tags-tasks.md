# Implementation Plan: Ticket Severity + Custom Tagging

**Spec:** docs/specs/ticket-severity-and-tags.md
**Generated:** 2026-09-05
**Status:** All phases done (T1-T17, plus T10b/T10c added mid-Phase-3 as a scope
expansion — see below). Feature complete, ready for upstream PR.

---

## Phase 1 — Data Model

**Goal:** `entity_instances` gains a mandatory-by-form severity enum column, plus a new
tenant-scoped, RLS-enabled tags join table with the composite uniqueness constraint the
creator-lock and dedup rules depend on.
**Gate:** all unit tests pass, `pnpm typecheck` clean → then Phase 2

| task                                                                                                                                                                                            | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Add nullable `severity` column (Low/Medium/High/Critical enum, rank-ordered) to `entity_instances` in `packages/db/src/schema/entity-engine.ts` + migration, no backfill                    | R1, R2, R7  | done   |
| T2: Create `entity_instance_tags` join table (tenant_id, entity_instance_id, tag_text, created_by, created_at) with RLS + composite unique index on `(tenant_id, entity_instance_id, tag_text)` | R4, R5, R7  | done   |
| T3: Migration files + `meta/_journal.json` entries + analytics annotations on both schema changes                                                                                               | R1, R4, R7  | done   |
| T4: Zod schemas + TS types for severity enum and tag shape in entity-engine (`z.infer`-derived, per code-style.md)                                                                              | R1, R4      | done   |
| T5: Isolation tests: RLS on `entity_instance_tags`, composite-uniqueness constraint rejects concurrent duplicate                                                                                | R4, R5, R7  | done   |

---

## Phase 2 — API / Service Layer

**Goal:** Create/update endpoints enforce severity rules, tag CRUD enforces creator-lock +
admin override, both write audit-log entries, severity changes fire notifications via the
existing outbound service, records-list endpoint supports both filters.
**Gate:** integration + isolation tests pass + Phase 1 gate still green

| task                                                                                                                                                                                                                                      | requirement        | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| T6: Ticket-create routes (admin-ui-facing) require severity, default Medium; third-party API create route always writes Medium unconditionally, no severity param accepted                                                                | R1                 | done   |
| T7: Ticket-edit route: reject save when severity is NULL/missing; on change, write `severity.changed` audit-log entry + call existing outbound notification service for every user in the ticket's access list                            | R2, R3             | done   |
| T8: Tag-add route: normalize (trim+lowercase), reject empty, reject >50 chars, rely on DB composite constraint for same-ticket dedup (surface constraint violation as "already exists on this ticket"), write `tag.added` audit-log entry | R4, R5             | done   |
| T9: Tag-remove route: enforce creator-lock (only `created_by` may remove) with global/workflow-admin override, write `tag.removed` audit-log entry (recording original creator id when overridden)                                        | R5                 | done   |
| T10: Records-list route: add severity filter (one or more levels) and tag filter (normalized exact match) query params, composable with existing Source filter                                                                            | R6                 | done   |
| T11: Isolation + integration tests for T6–T10 (creator-lock enforcement, admin override, notification fan-out via existing service, third-party API always-Medium path)                                                                   | R1, R2, R3, R5, R6 | done   |
| T10b: (added mid-Phase-3, scope expansion) list.ts gains an origin/Source filter query param, alongside severity/tag, so the records page's Source filter can also move server-side                                                       | R6                 | done   |
| T10c: (added mid-Phase-3) my-tickets.ts (the separate aggregating endpoint for plain "user"-role callers) gains its own severity/tag/origin filter conditions mirroring list.ts's, so both fetch paths filter identically server-side     | R6                 | done   |

---

## Phase 3 — Consumer UI

**Goal:** Ticket creation and detail pages expose severity + tags per the spec's UX rules;
records page gets severity + tag filters; all changes visible in ticket activity history.
**Gate:** §R acceptance criteria met, `pnpm test` + `pnpm test:isolation` green, `pnpm typecheck`/`pnpm lint` clean

| task                                                                                                                                                                                                   | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T12: Ticket-create form: severity field pre-filled Medium, changeable, required (client + relies on T6 server validation)                                                                              | R1          | done   |
| T13: Ticket-detail page: severity control editable by creator/assignee/workflow-admin/global-admin only, shows red-asterisk required state when NULL and blocks save via existing Edit-form validation | R2, R3      | done   |
| T14: Ticket-detail page: tag add/remove UI — add open to any edit-access user, remove button only rendered/enabled for the tag's creator or admins (server still enforces via T9)                      | R4, R5      | done   |
| T15: Ticket-detail activity/timeline: render `severity.changed`, `tag.added`, `tag.removed` entries (actor, timestamp, and old/new or creator-override detail)                                         | R3, R5      | done   |
| T16: Records page: severity filter control (multi-select, color-coded per §I's rank/color table) + debounced tag-text filter input, both composing with existing Source filter                         | R6          | done   |
| T17: Component/e2e tests for T12–T16                                                                                                                                                                   | R1–R6       | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/ticket-severity-and-tags.md and docs/specs/ticket-severity-and-tags-tasks.md.

Implement Phase 1 tasks only (T1–T5).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
