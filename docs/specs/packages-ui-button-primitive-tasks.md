# Implementation Plan: packages/ui Button & IconButton primitives

**Spec:** docs/specs/packages-ui-button-primitive.md
**Generated:** 2026-08-01
**Status:** not started

---

## Phase 1 — Primitives

**Goal:** `Button` and `IconButton` exist in `packages/ui`, tested, exported.
**Gate:** `pnpm --filter @platform/ui test && pnpm --filter @platform/ui typecheck` pass

| task                                                                                                           | requirement | status |
| -------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Add `packages/ui/src/button.tsx` (variant: primary/secondary/danger, size: default/sm) + `button.test.tsx` | R1, R4      | todo   |
| T2: Add `packages/ui/src/icon-button.tsx` (variant: default/edit/delete/ghost) + `icon-button.test.tsx`        | R2, R4      | todo   |
| T3: Export `Button`, `IconButton` from `packages/ui/src/index.ts`                                              | R1, R2      | todo   |

---

## Phase 2 — Migration

**Goal:** all 17 admin-ui files render buttons via the new primitives instead of raw `btn*`/`icon-btn*` classNames.
**Gate:** `pnpm typecheck && pnpm lint && pnpm test` pass (repo-wide) + Phase 1 gate still green

| task                                                                                                                                                          | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4: Migrate `entity-types/{detail,index,instance-detail,instance-create}.tsx`, `records/index.tsx`, `dashboard.tsx`, `modules.tsx`                            | R3          | todo   |
| T5: Migrate `workflows/{create,detail,index}.tsx`, `automations/index.tsx`, `automations/wizard/{wizard,step-actions,step-conditions}.tsx`, `system-logs.tsx` | R3          | todo   |
| T6: Migrate `customer/record-list.tsx`, `customer/record-detail.tsx`                                                                                          | R3          | todo   |

---

## Phase 3 — Cleanup & verification

**Goal:** dead CSS removed, visual parity confirmed by hand.
**Gate:** §R acceptance criteria met — zero raw `btn*`/`icon-btn*` occurrences, full exit condition green, manual smoke pass done

| task                                                                                                                                                                                                                                                                  | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: Remove now-dead `.btn`, `.btn-primary`, `.btn-primary-sm`, `.btn-secondary`, `.btn-sm`, `.btn-danger-sm`, `.icon-btn`, `.icon-btn-edit`, `.icon-btn-delete`, `.icon-btn-ghost` rules from `index.css`; **keep** `.btn-icon`/`.btn-edit-sm` (still used, deferred) | R3          | todo   |
| T8: `pnpm dev`, manually visit all 17 touched pages, confirm no visual regression; full exit condition (`typecheck`, `lint`, `test`, `test:isolation`)                                                                                                                | R1, R2, R3  | todo   |

---

## Kick-Off Prompt

```
Read docs/specs/packages-ui-button-primitive.md and docs/specs/packages-ui-button-primitive-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until Phase 1's gate (packages/ui test + typecheck) is green
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec (e.g. which modifier class a bare
  `icon-btn` pairs with at a given call site), stop and ask — do not assume
- If a test fails, log it in the spec's §B before fixing
- If the same bug class could recur, promote it to §V as an invariant
```
