# packages/ui — export & consume design tokens (issue #199 continuation)

> Close the remaining #199 gap flagged in `roadmap-tracker.md`: `packages/ui/src/tokens.ts`
> exists but isn't exported, so PR #328's newly-migrated `system-logs.tsx`/`users.tsx` still
> hand-roll their own token strings — one of them (`users.tsx`'s `--bg-tertiary` fallback,
> `hsl(222, 15%, 16%)`) has drifted from the canonical value (`hsl(222, 14%, 23%)`) already
> fixed once in `tokens.ts` itself.

status: draft
created: 2026-08-04
updated: 2026-08-04

---

## §G Goal

`TOKENS` is exported from `@platform/ui` and is the single source both `system-logs.tsx` and
`users.tsx` pull their `var(--name, fallback)` strings from — no page-local re-declaration of a
fallback `tokens.ts` already defines. The one confirmed drifted literal is fixed. The two
hand-rolled `onMouseEnter`/`onMouseLeave` hover pairs in `users.tsx` go through one shared,
reusable hover primitive instead of duplicated inline mutation of `el.style`.

---

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | React 18, `packages/ui` (tsc-only build, no CSS/asset pipeline — same boundary as `button.tsx`/`dialog.tsx`)                                                                                                                                                                                                               |
| styling      | Inline `React.CSSProperties` / imperative `el.style` referencing `TOKENS`'s existing `var(--name, fallback)` strings — no new token names invented, no Tailwind, no CSS-in-JS                                                                                                                                              |
| scope: files | `apps/admin-ui/src/pages/system-logs.tsx`, `apps/admin-ui/src/pages/users.tsx` only                                                                                                                                                                                                                                        |
| out of scope | `AVATAR_COLORS` (`users.tsx:47-55`, 8 raw hex, decorative avatar palette) and other raw-hex status-color palettes in `records/index.tsx`, `workflows/index.tsx`, `entity-types/instance-detail.tsx` — file as follow-up issue, not touched here                                                                            |
| out of scope | The other ~9 files with hand-rolled `onMouseEnter`/`onMouseLeave` (`user-picker.tsx`, `notification-bell.tsx`, `dashboard.tsx`, `modules.tsx`, `records/index.tsx`, `layout.tsx`, `workflows/detail.tsx`, 3 `customer/*` pages) — same hook will fit them, but migrating them is a separate follow-up issue, not this unit |
| out of scope | No ADR — this is a spec-tracked implementation unit, not a new architectural decision (tokens.ts and its export boundary already exist; this just plugs the last gap)                                                                                                                                                      |

---

## §I Interfaces

**`packages/ui/src/index.ts`** — add:

```ts
export { TOKENS } from "./tokens.js";
```

**`packages/ui/src/use-hover-style.ts`** (new file) — a hook, not a component, so it works on
both a `<TableRow>` and a plain `<span>` (the Zitadel-link icon isn't a table row):

```ts
interface HoverStyleOptions {
  base: React.CSSProperties;
  hover: React.CSSProperties;
}
// Returns the props to spread on the element: style starts at `base`,
// onMouseEnter/onMouseLeave swap between base and { ...base, ...hover }.
function useHoverStyle(options: HoverStyleOptions): {
  style: React.CSSProperties;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: (e: React.MouseEvent) => void;
};
```

No ref/DOM-node access required — `users.tsx`'s two current usages both target
`e.currentTarget`, which this hook mirrors internally instead of taking an external ref.

The two call sites' `base` objects are **not symmetric** — confirmed by reading current code
(`users.tsx:216-226`, `:350-360`):

- Table row (line 216): `base = { background: "" }` (mouseleave today unsets `background` to
  `""`, i.e. inherit — not an explicit color)
- Icon link (line 350): `base = { background: "", color: TOKENS.textMuted }` (mouseleave resets
  `color` to the explicit `var(--text-muted)`, not unset — `color` is stateful, `background` isn't)

**Call-site changes** (line numbers as of `feat/PLAT-199-ui-table-primitive` @ `7f93391`):

| file              | line(s) | current                                                | new                                                                                                     |
| ----------------- | ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `system-logs.tsx` | 114     | `background: "#ef4444"`                                | `background: TOKENS.danger`                                                                             |
| `system-logs.tsx` | 173     | `"1px solid var(--border)"`                            | `` `1px solid ${TOKENS.borderColor}` ``                                                                 |
| `users.tsx`       | 216-225 | hand-rolled `onMouseEnter`/`onMouseLeave` on table row | `useHoverStyle({ base: {...}, hover: { background: TOKENS.bgTertiary } })`                              |
| `users.tsx`       | 309     | `"var(--bg-tertiary, hsl(222, 15%, 16%))"` (drifted)   | `TOKENS.bgTertiary`                                                                                     |
| `users.tsx`       | 350-360 | hand-rolled `onMouseEnter`/`onMouseLeave` on icon link | `useHoverStyle({ base: {...}, hover: { background: TOKENS.bgTertiary, color: TOKENS.accentPrimary } })` |
| `users.tsx`       | 390     | `"1px solid var(--border)"`                            | `` `1px solid ${TOKENS.borderColor}` ``                                                                 |

`AVATAR_COLORS` (line 54, part of an 8-entry array) is explicitly untouched — out of scope per §C.

---

## §R Requirements

**R1: `TOKENS` is a public `@platform/ui` export**
✓ `import { TOKENS } from "@platform/ui"` resolves and type-checks from `apps/admin-ui`
✓ `button.test.tsx`, `dialog.test.tsx`, `alert-dialog.test.tsx`, `table.test.tsx` all pass
unchanged — confirms the export doesn't alter how existing components consume `TOKENS` internally

**R2: `system-logs.tsx` and `users.tsx` source every token value from `TOKENS`, not a local literal**
✓ Zero remaining `var(--` string literals in either file for names `TOKENS` already covers
(`danger`, `border-color`, `bg-tertiary`, `accent-primary`) — `grep -n 'var(--' <file>` returns
only names absent from `TOKENS` (i.e., nothing, per the table above) or the explicitly
out-of-scope `AVATAR_COLORS`
✓ The drifted `hsl(222, 15%, 16%)` fallback (3 occurrences in `users.tsx`) no longer appears
anywhere in the file

**R3: Hover styling on the migrated table row and icon link goes through `useHoverStyle`**
✓ `users.tsx`'s table-row hover (line ~216) and Zitadel-link icon hover (line ~350) both call
`useHoverStyle` instead of manually reading/writing `e.currentTarget.style`
✓ Visual hover behavior is unchanged (same background/color swap on mouseenter, same revert on
mouseleave) — manual smoke check, not just a type check
✓ `use-hover-style.test.ts` covers: initial style equals `base`; simulated mouseenter merges
`hover` into style; simulated mouseleave reverts to `base`

**R4: No regression in `system-logs.tsx`/`users.tsx` rendering**
✓ Manual smoke pass on both pages (`pnpm dev`) — urgent-log dot still red, table-row hover still
visible, Zitadel icon-link hover still visible, border rules still render

---

## §V Invariants

- `packages/ui` ships no CSS/asset pipeline (tsc-only build) — `TOKENS` values and
  `useHoverStyle`'s inline styles are the only two mechanisms; no new stylesheet, no Tailwind, no
  CSS-in-JS library gets introduced by this or any future token-consumption cleanup.
- Any `var(--name, fallback)` string written by hand outside `packages/ui/src/tokens.ts` is a
  latent drift bug the moment `tokens.ts`'s fallback for that name changes — this is exactly what
  happened with `users.tsx`'s `bg-tertiary` (16% vs. the corrected 23%). Prefer importing
  `TOKENS.<name>` over re-typing `var(--name, ...)` anywhere `packages/ui` already defines that
  name.

## §T Tasks

| id  | task                                                                                                        | phase | status | depends  |
| --- | ----------------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Export `TOKENS` from `packages/ui/src/index.ts`                                                             | 1     | todo   | —        |
| T2  | Add `useHoverStyle` hook to `packages/ui` + `use-hover-style.test.ts`                                       | 1     | todo   | —        |
| T3  | Export `useHoverStyle` from `packages/ui/src/index.ts`                                                      | 1     | todo   | T2       |
| T4  | `system-logs.tsx`: replace `#ef4444` and `var(--border)` with `TOKENS` equivalents                          | 2     | todo   | T1       |
| T5  | `users.tsx`: replace 3 drifted `bg-tertiary` literals and `var(--border)` with `TOKENS`                     | 2     | todo   | T1       |
| T6  | `users.tsx`: migrate table-row + icon-link hover to `useHoverStyle`                                         | 2     | todo   | T3       |
| T7  | Manual smoke pass on both pages + full exit condition                                                       | 3     | todo   | T4,T5,T6 |
| T8  | File follow-up issue for out-of-scope items (§C: `AVATAR_COLORS`, other palettes, other 9 hand-hover files) | 3     | todo   | —        |

phase gate: typecheck + lint + test pass before advancing to next phase; phase 3 additionally
requires the manual smoke pass since hover/color rendering isn't fully covered by unit tests

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
