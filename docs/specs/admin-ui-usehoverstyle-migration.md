# admin-ui — migrate remaining hand-rolled hover to useHoverStyle (#331)

> Follow-up from #199/PR #330. `useHoverStyle` (added in PR #330,
> `packages/ui/src/use-hover-style.ts`) already fits every remaining hand-rolled
> `onMouseEnter`/`onMouseLeave` site in `apps/admin-ui` — this is mechanical migration across 10
> files, not new design work. The raw-hex-palette half of the original issue #331 filing turned
> out to need no migration (decorative palettes, or no safe token mapping exists) — see #331's
> updated body; not covered by this spec.

status: draft
created: 2026-08-04
updated: 2026-08-04

---

## §G Goal

Every `onMouseEnter`/`onMouseLeave` pair across the 10 files below that currently mutates
`e.currentTarget.style` directly instead goes through `useHoverStyle`. Visual hover behavior is
unchanged. Sites inside a `.map()` callback get extracted into a named child component first
(same pattern as PR #330's `UserRow`) — hooks can't be called inside a loop callback.

---

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | React 18, existing `useHoverStyle` from `@platform/ui` — no new packages/ui API needed                                                                                                                                                                                                                                                                   |
| scope: files    | The 10 files in §I's table only                                                                                                                                                                                                                                                                                                                          |
| out of scope    | Raw-hex color palettes (`AVATAR_COLORS`, `CARD_GRADIENTS`, `ACCENT_PALETTE`, `instance-detail.tsx`'s `stateBadge()`) — see #331's updated body for why                                                                                                                                                                                                   |
| out of scope    | `dashboard.tsx`'s `KpiCard` hover (already its own extracted component, top-level within it) and `modules.tsx`'s `ModuleCard` hover (already React-state-driven, not the `e.currentTarget.style` anti-pattern) — both **can** adopt `useHoverStyle` but aren't the anti-pattern this spec targets; included in §T as a cheap win, not the primary driver |
| bonus, in scope | `customer/record-detail.tsx`'s hover pair uses literal `#ef4444`/`#fca5a5` instead of `TOKENS.danger` — same token-drift class as PR #330; fix while touching that file                                                                                                                                                                                  |

---

## §I Interfaces

No new `packages/ui` API — `useHoverStyle({ base, hover })` already covers every site (see PR
#330 / `packages/ui/src/use-hover-style.ts` for the exact signature). Per-file inventory (line
numbers as of `main` post-#330):

| file                               | pairs | element(s)                                                                                                    | extraction needed?                                       |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `components/user-picker.tsx`       | 3     | 1 static "Unassign" row (268/272), 2 list rows in `filtered.map`                                              | 2 of 3 (list rows)                                       |
| `components/notification-bell.tsx` | 1     | bell button                                                                                                   | No                                                       |
| `pages/dashboard.tsx`              | 5     | `KpiCard` (own component already), perf row, record row, quick-link, quick-action button (latter 4 in `.map`) | 4 of 5                                                   |
| `pages/modules.tsx`                | 2     | `ModuleCard` (state-driven, not the anti-pattern), preview button                                             | No (both already inside an extracted per-item component) |
| `pages/records/index.tsx`          | 1     | `WorkflowCardGrid` card, inside `items.map`                                                                   | Yes                                                      |
| `components/layout.tsx`            | 2     | profile button, sign-out button                                                                               | No                                                       |
| `pages/workflows/detail.tsx`       | 2     | `SortableStateNode` drag handle (own component already), remove-assignee button (inside `assignedTo.map`)     | 1 of 2                                                   |
| `pages/customer/record-create.tsx` | 2     | static "Unassigned" row, user row inside `filtered.map`                                                       | 1 of 2                                                   |
| `pages/customer/record-detail.tsx` | 1     | "change access" button, inside `accessUsers.map` — also has the literal-hex bonus fix                         | Yes                                                      |
| `pages/customer/record-list.tsx`   | 1     | export-format button, inside an inline array `.map`                                                           | Yes                                                      |

---

## §R Requirements

**R1: Every hand-rolled hover site in the 10 files goes through `useHoverStyle`**
✓ `grep -rn "currentTarget.*style\." apps/admin-ui/src/{components,pages}` returns nothing for
these 10 files as a fast heuristic — NOT sufficient alone, since the anti-pattern often spans
multiple lines (`const el = e.currentTarget as X; el.style.y = ...`); each file also gets a
manual read confirming no `e.currentTarget`-captured `.style` mutation remains for hover purposes
(excluding the two already-fine sites in `dashboard.tsx`'s `KpiCard` and `modules.tsx`'s
`ModuleCard`, which migrate too as a cheap win per §C)
✓ Visual hover behavior unchanged — manual smoke pass at the end of **each phase** (see §T phase
gates), not deferred entirely to the final task

**R2: `.map()`-based sites are extracted into a named child component before adopting the hook**
✓ Each of `user-picker.tsx` (2 rows), `dashboard.tsx` (4 sites), `records/index.tsx` (1),
`workflows/detail.tsx` (1), `customer/record-create.tsx` (1), `customer/record-detail.tsx` (1),
`customer/record-list.tsx` (1) has its loop body in a named function component receiving the
loop item as a prop — same shape as PR #330's `UserRow`
✓ No "Rendered more hooks than during previous render" React error on list-length change (covered
by a render test with a variable-length list, not just a fixed one)

**R3: `customer/record-detail.tsx`'s literal hex bonus fix**
✓ `#ef4444`/`#fca5a5` (hover pair, ~line 3904) replaced with `TOKENS.danger` (or a documented
reason if `TOKENS.danger`'s value doesn't visually match — confirm before assuming)

**R4: No regression across all 10 files**
✓ Full repo exit condition green
✓ Manual smoke pass per file touched (dev server, hover each migrated element)

---

## §V Invariants

- (inherited from PR #330's spec) Any `var(--name, fallback)` or raw hex literal written by hand
  where `TOKENS` already defines that concept is a latent drift bug — prefer `TOKENS.<name>`.
- Hooks cannot be called inside a `.map()`/loop callback — any per-item hover state requires
  extracting the loop body into its own named component first. This bit PR #330 (`UserRow`) and
  will bite every file in this spec's §I table marked "extraction needed."
- When extracting a `.map()` body into a named component, the `key` prop must move to the
  component call site unchanged (same value, same position) — an extraction that drops or
  recomputes the key differently causes React to remount instead of update, silently losing
  focus/animation/internal state on every render. Verify the key is identical before/after, not
  just that the visual output looks the same.

## §T Tasks

Phased so each phase is a plausible standalone PR — the "likely worth splitting into 2+ PRs" note
from #331's filing. Phase A needs no extraction (fast, low-risk); Phase B is the extraction-heavy
half; Phase C is the bonus fix + full verification.

| id  | task                                                                                            | phase | status | depends |
| --- | ----------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migrate `notification-bell.tsx` (1 pair, no extraction)                                         | A     | done   | —       |
| T2  | Migrate `layout.tsx` (2 pairs, no extraction)                                                   | A     | done   | —       |
| T3  | Migrate `modules.tsx`'s `ModuleCard`/preview button (2 pairs, no extraction — already per-item) | A     | done   | —       |
| T4  | Migrate `dashboard.tsx`'s `KpiCard` (no extraction — already per-item)                          | A     | done   | —       |
| T4a | Manual smoke pass on T1-T4's 3 files + phase A exit condition                                   | A     | done   | T1-T4   |
| T5  | Extract + migrate `user-picker.tsx`'s 2 list-row pairs; migrate its 1 static pair               | B     | done   | T4a     |
| T6  | Extract + migrate `dashboard.tsx`'s remaining 4 `.map()`-based pairs                            | B     | done   | T4a     |
| T7  | Extract + migrate `records/index.tsx`'s `WorkflowCardGrid` card hover                           | B     | done   | T4a     |
| T8  | Extract + migrate `workflows/detail.tsx`'s remove-assignee button                               | B     | done   | T4a     |
| T8a | Manual smoke pass on T5-T8's 4 files + phase B exit condition                                   | B     | done   | T5-T8   |
| T9  | Extract + migrate `customer/record-create.tsx` (both pairs)                                     | C     | done   | T8a     |
| T10 | Extract + migrate `customer/record-detail.tsx` (1 pair) + bonus hex-to-`TOKENS.danger` fix (R3) | C     | done   | T8a     |
| T11 | Extract + migrate `customer/record-list.tsx` (1 pair)                                           | C     | done   | T8a     |
| T12 | Manual smoke pass on T9-T11's 3 customer-facing files + full exit condition                     | C     | done   | T9-T11  |

phase gate: typecheck + lint + test pass before advancing; each phase's smoke-pass task (T4a,
T8a, T12) additionally requires the manual pass, since hover/color rendering isn't fully covered
by unit tests — this catches a regression at the end of its own phase rather than only at T12

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
