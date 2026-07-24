# Implementation Plan: Nit-bug batch #182–#185

**Spec:** docs/specs/nit-bugs-182-185.md
**Generated:** 2026-07-24
**Status:** implemented (verification in progress)

Four independent fixes, no cross-dependencies. Phases below are a formality — each task
is its own commit and could ship in any order — but T1/T2/T4 (config/dev-tooling/core
entity-engine domain logic) are grouped as Phase 1, and T3 (API route layer) as Phase 2,
per this repo's phase-assignment convention.

---

## Phase 1 — Config & core domain logic

**Goal:** Fix the two documentation/config nits and the entity-engine duplication, all
with no cross-package dependencies.
**Gate:** typecheck + lint + unit tests pass → then Phase 2

| task                                                                                                                                                                                                                           | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T1: `apps/worker/package.json` — bump `"hono"` to `^4.12.25`; comment lives in `pnpm-workspace.yaml` (JSON can't hold one)                                                                                                     | R1          | done   |
| T2: `.claude/hooks/lib/context.js` — one-line comment on the worktree `.git`-is-a-file intent, placed at the `git rev-parse --show-toplevel` delegation (the function never stats `.git` itself)                               | R2          | done   |
| T4: `packages/entity-engine/src/engine.ts` — extract `CHILD_TICKET_STATES` module-level constant (`readonly string[]`, not `as const`); repoint all 4 inline-array sites (`updateEntity` ×2, `bulkSetState`, `setEntityState`) | R4          | done   |

---

## Phase 2 — API layer

**Goal:** Close the 500-instead-of-404 gap on deleted-workflow lookups. Scope widened
from the issue's 3 named files (2 nonexistent) to the real 11-file footprint after
direct inspection — see spec §R3. User approved fixing all 11 via one central case
(option 1 of 3 presented) rather than the literally-scoped 1 file or 11 duplicated
per-file try/catches.
**Gate:** tests pass (404 asserted, not 500) + Phase 1 gate still green

| task                                                                                                                                                                                               | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T3a: `apps/api/src/lib/handle-entity-error.ts` — add `WorkflowError`(`WORKFLOW_NOT_FOUND`) → 404 case; fixes 9 of the 11 files for free (they already funnel through this)                         | R3          | done   |
| T3b: `apps/api/src/routes/entities/add-comment.ts` — wrap its uncaught `getWorkflow` call in try/catch → `handleEntityError`                                                                       | R3          | done   |
| T3c: `apps/api/src/routes/entities/update.ts` — same fix for its uncaught call site                                                                                                                | R3          | done   |
| T3d: `apps/api/src/lib/handle-entity-error.test.ts` (new) — unit tests: `WORKFLOW_NOT_FOUND`→404, other `WorkflowError` codes still →500, existing `ValidationError`/`EntityError` cases unchanged | R3          | done   |
| T3e: `add-comment.test.ts`, `update.test.ts` — end-to-end regression test per file asserting 404 (not 500) via the real `handleEntityError`                                                        | R3          | done   |

---

## Notes

- `pnpm test:isolation` requires Docker/OrbStack. None of these four fixes touch RLS or
  tenant-scoped tables, but the exit condition still calls for all four checks —
  availability will be checked at verification time; if unavailable, this will be
  logged in `PROGRESS.md` rather than silently skipped.
- Ships as one PR off `chore/PLAT-182-nit-bugs-batch` (based on PR #181's tip), separate
  from PR #181 per explicit decision — the RLS PR stays untouched.

## Kick-Off Prompt

```
Read docs/specs/nit-bugs-182-185.md and docs/specs/nit-bugs-182-185-tasks.md.

Implement Phase 1 tasks (T1, T2, T4), then Phase 2 (T3a–T3d).

Rules:
- Do not begin Phase 2 until Phase 1's gate (typecheck+lint+unit tests) is green
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, log it before fixing
- One commit per task (T1, T2, T3, T4 — or T3a-d combined into one T3 commit)
```
