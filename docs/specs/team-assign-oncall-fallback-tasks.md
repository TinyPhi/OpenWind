# Implementation Plan: Team-Assign at Ticket Creation + On-Call Fallback to Workflow Admin

**Spec:** docs/specs/team-assign-oncall-fallback.md
**Generated:** 2026-09-21
**Status:** implemented (all 3 phases + T14 scope widening) — pending `/review`, docs marker, and
commit. Verification: `pnpm --filter @platform/api exec vitest run` (excl. 3 known-flaky files)
194/194 files, 1514/1514 tests pass; `pnpm --filter @platform/admin-ui test` 46/46 files, 320/320
tests pass; `pnpm --filter @platform/entity-engine --filter @platform/teams
--filter @platform/automation-engine --filter @platform/api --filter @platform/admin-ui run lint`
clean.

---

## Phase 1 — Data Model & Create-Time Contract

**Goal:** `team_id` exists as a real, optional, non-Other-tab-visible field on every per-tenant
workflow, and `POST /entities` accepts exactly one of `assignedTo`/`teamId`.
**Gate:** unit + isolation tests pass → then Phase 2

| task                                                                                                                                                  | requirement | status                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------ |
| T1: Choose `team_id` entity-field `fieldType` (entity-ref to `teams.id` vs plain text)                                                                | R2          | done — `text`, see entity-types.ts comment |
| T2: Seed `team_id` (`isRequired: false`) in `createEntityType`, alongside existing `title` auto-seed                                                  | R2          | done                                       |
| T3: One-off backfill — add `team_id` field to existing dev-tenant workflows missing it (13, not 12 — one new workflow since the prior title backfill) | R2          | done                                       |
| T4: `CreateEntitySchema` — `assignedTo`/`teamId` exactly-one-of `.superRefine`; write `teamId` to `fields.team_id`                                    | R1, R3      | done                                       |
| T12: Unit test — `CreateEntitySchema` rejects neither-set (400) and both-set (400) requests; teamId not resolving to a real tenant team (422)         | R1          | done                                       |

---

## Phase 2 — On-Call Cascade Extension & System Comment

**Goal:** `resolve_oncall` falls through to the workflow-admin tier on either fail-open exit, and
posts exactly one system comment per terminal outcome (assigned or fully fail-open).
**Gate:** isolation tests pass + Phase 1 gate still green

| task                                                                                                                                                                                                                     | requirement | status                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T5: Extend `CascadeResult`/`OncallTier` union in `packages/teams/src/oncall-resolver.ts` with `"workflow_admin"`                                                                                                         | R4          | done                                                                                                                                                                        |
| T6: `resolve-oncall.ts` — workflow-admin fallback lookup + assignment, wired into BOTH fail-open exits (no-schedule-at-all AND cascade-exhausted), preserving existing idempotency-claim/explicit-assignee-wins ordering | R4          | done — `getWorkflowByEntityTypeId` already orders by `createdAt` (issue #168's own fix), so R4's accepted-risk note was already mitigated                                   |
| T7: New automation-engine comment-posting helper (`workflowEvents` + `outboxEvents`, no `apps/api` import — dependency rule)                                                                                             | R5          | done — `packages/automation-engine/src/actions/post-oncall-comment.ts`                                                                                                      |
| T8: Wire T7 into `resolve-oncall.ts`'s success path AND both fail-open exit paths; single-comment-per-idempotency-key invariant; exact copy per R5                                                                       | R5          | done                                                                                                                                                                        |
| T11: Isolation tests — both fail-open exits reach workflow-admin tier; comment content + idempotency across all 4 tiers and the fail-open case                                                                           | R4, R5      | done — also fixed 2 pre-existing test-hygiene bugs this surfaced (stale `automation_rules` never cleaned between runs; a `team_id` field collision with T2's new auto-seed) |

---

## Phase 3 — Ticket-Creation UI

**Goal:** Both creation forms expose the User/Team toggle; `team_id` never leaks into the generic
Other-tab field list.
**Gate:** §R acceptance criteria met (full spec done)

| task                                                                                                                                                                                        | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T9: `record-create.tsx` — User/Team assign-mode toggle on the Mandate tab; exclude `team_id` from `otherFields`                                                                             | R1, R2      | done   |
| T10: `instance-create.tsx` — same toggle + Other-tab exclusion                                                                                                                              | R1, R2      | done   |
| T13: Unit test — `team_id` never appears in the Other-tab field list on either creation form                                                                                                | R2          | done   |
| T14 (added, out-of-band scope widening, human-approved): `GET /admin/teams` widened to allow `user` role (AC6) — needed since `record-create.tsx` is reachable by plain `user`-role callers | R1          | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/team-assign-oncall-fallback.md and docs/specs/team-assign-oncall-fallback-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4, T12).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
