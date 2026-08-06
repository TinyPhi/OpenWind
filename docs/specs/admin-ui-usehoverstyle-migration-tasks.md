# Implementation Plan: admin-ui — migrate remaining hand-rolled hover to useHoverStyle (#331)

**Spec:** docs/specs/admin-ui-usehoverstyle-migration.md
**Generated:** 2026-08-04
**Status:** not started — blocked on PR #330 merging to main first (this work builds on
`useHoverStyle`/`TOKENS`, which only exist on the unmerged `feat/PLAT-199-design-token-consumption`
branch)

---

## Phase A — No-extraction sites (fast, low-risk)

**Goal:** Migrate the 4 hover sites that need no component extraction — already top-level or
already per-item.
**Gate:** typecheck + lint + test pass → then manual smoke pass (T4a) → then Phase B

| task                                                                                                                                  | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Migrate `notification-bell.tsx` (1 pair)                                                                                          | R1          | done   |
| T2: Migrate `layout.tsx` (2 pairs)                                                                                                    | R1          | done   |
| T3: Migrate `modules.tsx`'s `ModuleCard`/preview button (2 pairs)                                                                     | R1          | done   |
| T4: Migrate `dashboard.tsx`'s `KpiCard` (1 pair)                                                                                      | R1          | done   |
| T4a: Manual smoke pass on `notification-bell.tsx`, `layout.tsx`, `modules.tsx`, `dashboard.tsx` (KpiCard only) + phase exit condition | R1, R4      | done   |

---

## Phase B — Extraction-heavy internal-admin sites

**Goal:** Extract `.map()` loop bodies into named components, then migrate their hover to
`useHoverStyle`, for the 4 internal (non-customer-facing) files that need it.
**Gate:** typecheck + lint + test pass + Phase A gate still green → then manual smoke pass (T8a)
→ then Phase C

| task                                                                                                                             | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: Extract + migrate `user-picker.tsx`'s 2 list-row pairs; migrate its 1 static pair                                            | R1, R2      | done   |
| T6: Extract + migrate `dashboard.tsx`'s remaining 4 `.map()`-based pairs (perf row, record row, quick-link, quick-action)        | R1, R2      | done   |
| T7: Extract + migrate `records/index.tsx`'s `WorkflowCardGrid` card hover                                                        | R1, R2      | done   |
| T8: Extract + migrate `workflows/detail.tsx`'s remove-assignee button                                                            | R1, R2      | done   |
| T8a: Manual smoke pass on `user-picker.tsx`, `dashboard.tsx`, `records/index.tsx`, `workflows/detail.tsx` + phase exit condition | R1, R2, R4  | done   |

---

## Phase C — Customer-facing sites (higher blast radius — kept as 3 separate small tasks)

**Goal:** Extract + migrate the 3 `customer/*` files individually, plus the bonus token-drift fix.
**Gate:** §R acceptance criteria met (full exit condition + manual smoke pass)

| task                                                                                     | requirement | status |
| ---------------------------------------------------------------------------------------- | ----------- | ------ |
| T9: Extract + migrate `customer/record-create.tsx` (2 pairs)                             | R1, R2      | done   |
| T10: Extract + migrate `customer/record-detail.tsx` (1 pair) + bonus `TOKENS.danger` fix | R1, R2, R3  | done   |
| T11: Extract + migrate `customer/record-list.tsx` (1 pair)                               | R1, R2      | done   |
| T12: Manual smoke pass on all 3 customer files + full repo exit condition                | R4          | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code session to start implementation — **only after PR #330 has
merged to `main`** (this spec's `useHoverStyle`/`TOKENS` exports don't exist on `main` until then):

```
Read docs/specs/admin-ui-usehoverstyle-migration.md and
docs/specs/admin-ui-usehoverstyle-migration-tasks.md.

Confirm PR #330 has merged to main and branch fresh off main before starting.

Implement Phase A tasks only (T1, T2, T3, T4, T4a).

Rules:
- Do not begin Phase B until T4a's manual smoke pass and Phase A's exit condition both pass
- After each task, run relevant tests and confirm pass before continuing
- When extracting a .map() body into a named component, verify the `key` prop moved unchanged
  (§V invariant) -- not just that the visual output looks the same
- If you hit a decision not covered by the spec, stop and ask -- do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
