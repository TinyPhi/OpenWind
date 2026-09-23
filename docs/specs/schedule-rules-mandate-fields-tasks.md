# Implementation Plan: Schedule Rules — Mandate Fields

**Spec:** docs/specs/schedule-rules-mandate-fields.md
**Generated:** 2026-09-22
**Status:** not started

---

## Phase 1 — Template schema

**Goal:** New `Template` shape (assignedTo/teamId/due_days/remark) validated at the schema
layer, old shape rejected.
**Gate:** `pnpm --filter @platform/scheduler test` green → then Phase 2

| task                                                                                                                                                                                            | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Rename `assignee_id`→`assignedTo`, `team_id`→`teamId` in `TemplateSchema`; add `due_days` (int >=0, required) and `remark` (string, required, matches `entities/create.ts`'s remark bounds) | R1, R4, R5  | todo   |
| T2: Add `superRefine` to `TemplateSchema` enforcing exactly one of `assignedTo`/`teamId`                                                                                                        | R1          | todo   |
| T3: Update `packages/scheduler/src/template.test.ts` for new shape + superRefine cases                                                                                                          | R1          | todo   |
| T4: Update `packages/scheduler/src/cross-tenant-refs.ts` (`validateScheduleRuleRefs`) to read `assignedTo`/`teamId` instead of `assignee_id`/`team_id`                                          | R1, R2, R3  | todo   |

---

## Phase 2 — Worker fire logic

**Goal:** `fireRule` renders due date from `due_days`, branches assignedTo-vs-teamId the
same way `entities/create.ts` does, and posts the remark as the first comment.
**Gate:** `pnpm --filter @platform/worker test` green + Phase 1 gate still green

| task                                                                                                                                                                                                                                                                          | requirement    | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T5: In `schedule-tick-worker.ts`'s `fireRule`, compute `dueDate = scheduledAt + rendered.due_days days` (ISO string) and pass as `createEntity`'s `dueDate`                                                                                                                   | R4             | todo   |
| T6: Branch createEntity call: `assignedTo` mode passes `assignedTo` directly (no `team_id` field write); `teamId` mode writes `fields.team_id` and omits `assignedTo` (mirrors create.ts lines ~273-297)                                                                      | R2, R3         | todo   |
| T7: After the create transaction commits, call `postRemarkComment` (best-effort, catch+log, same as create.ts) with `actorId: rule.createdBy`, `text: rendered.remark`                                                                                                        | R5             | todo   |
| T8: Update/add `apps/worker/src/schedule-tick-worker.test.ts` cases: assignedTo-mode fire, teamId-mode fire (asserts fields.team_id set, no assignedTo passed), due_days→dueDate math, remark posted, remark-post failure doesn't fail the fire                               | R2, R3, R4, R5 | todo   |
| T9: Update `apps/api/tests/isolation/resolve-oncall.isolation.test.ts` or add a new isolation test firing a teamId-mode rule end-to-end through the real `entity.created`→`resolve_oncall` pipeline, asserting the same system-comment shape as a manual team-assigned ticket | R2             | todo   |

---

## Phase 3 — Admin routes + UI

**Goal:** Create/update routes validate the new shape; the schedule-rules modal exposes
User/Team toggle, due-days input, and remark textarea, matching record-create.tsx's pattern.
**Gate:** §R acceptance criteria met (full `pnpm test` + `pnpm typecheck` + `pnpm lint` green)

| task                                                                                                                                                                                                                                                                                                                                                                                                | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T10: No route-schema changes needed beyond already-updated `TemplateSchema` re-export in `apps/api/src/routes/admin/schedule-rules.ts` (`CreateRuleSchema`/`UpdateRuleSchema` embed `TemplateSchema` directly) — verify and adjust the stale `{team_id, service_id, assignee_id}` inline type cast at update-route line ~434-446 to the new field names                                             | R1          | todo   |
| T11: Update `apps/api/src/routes/admin/schedule-rules.test.ts` for new template shape (create/update 422 cases for both-set / neither-set)                                                                                                                                                                                                                                                          | R1          | todo   |
| T12: Rework `RuleFormModal` in `apps/admin-ui/src/pages/schedule-rules/index.tsx`: replace `templateSeverity`-adjacent assignee/team inputs (currently absent) with an assignMode toggle (User/Team, same visual pattern as `record-create.tsx`), team picker / user picker, a due-days numeric input, and a remark textarea; wire into submit payload as `assignedTo`/`teamId`/`due_days`/`remark` | R6          | todo   |
| T13: Update `apps/admin-ui/src/pages/schedule-rules/index.test.tsx` (create + edit flows) for the new fields, incl. client-side required-field guard                                                                                                                                                                                                                                                | R6          | todo   |

---

## Kick-Off Prompt

Read docs/specs/schedule-rules-mandate-fields.md and docs/specs/schedule-rules-mandate-fields-tasks.md.

Implement Phase 1 tasks only (T1-T4).

Rules:

- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
