# Implementation Plan: packages/ui — export & consume design tokens (#199)

**Spec:** docs/specs/packages-ui-design-tokens-consumption.md
**Generated:** 2026-08-04
**Status:** not started

---

## Phase 1 — Export the primitives

**Goal:** `TOKENS` and a new `useHoverStyle` hook are public, tested `@platform/ui` exports.
**Gate:** all unit tests pass → then Phase 2

| task                                                                                            | requirement | status |
| ----------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Export `TOKENS` from `packages/ui/src/index.ts`                                             | R1          | todo   |
| T2: Add `useHoverStyle` hook (`packages/ui/src/use-hover-style.ts`) + `use-hover-style.test.ts` | R3          | todo   |
| T3: Export `useHoverStyle` from `packages/ui/src/index.ts`                                      | R3          | todo   |

---

## Phase 2 — Migrate the two consumer files

**Goal:** `system-logs.tsx` and `users.tsx` source every covered token from `TOKENS` and both
hover handlers go through `useHoverStyle`.
**Gate:** typecheck + lint + unit/integration tests pass + Phase 1 gate still green

| task                                                                                                                                                                                                                                    | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4: `system-logs.tsx` — replace `#ef4444` (line 114) and `var(--border)` (line 173) with `TOKENS.danger` / `` `1px solid ${TOKENS.borderColor}` ``                                                                                      | R2          | todo   |
| T5: `users.tsx` — replace the 3 drifted `bg-tertiary` literals (lines 220, 309, 353) and `var(--border)` (line 390) with `TOKENS.bgTertiary` / `TOKENS.borderColor`                                                                     | R2          | todo   |
| T6: `users.tsx` — migrate table-row hover (lines 216-226, `base = { background: "" }`) and icon-link hover (lines 350-360, `base = { background: "", color: TOKENS.textMuted }`, hover color `TOKENS.accentPrimary`) to `useHoverStyle` | R3          | todo   |

---

## Phase 3 — Verify and close out

**Goal:** No visual regression; out-of-scope items are captured, not silently dropped.
**Gate:** §R acceptance criteria met (full exit condition + manual smoke pass)

| task                                                                                                                                                              | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: Manual smoke pass on `system-logs.tsx` and `users.tsx` (`pnpm dev`) + full exit condition (`pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`) | R4          | todo   |
| T8: File follow-up GitHub issue for out-of-scope items (`AVATAR_COLORS`, other raw-hex palettes, the other ~9 hand-rolled-hover files)                            | —           | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code session to start implementation:

```
Read docs/specs/packages-ui-design-tokens-consumption.md and
docs/specs/packages-ui-design-tokens-consumption-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
