# packages/ui — Button & IconButton primitives

> Close the remaining #199 gap: `packages/ui` has `Dialog`/`AlertDialog` but no `Button` —
> every button in `apps/admin-ui` is a raw `<button className="btn-*">` styled by hand-written
> CSS in `index.css`, duplicated across 17 files.

status: draft
created: 2026-08-01
updated: 2026-08-01

---

## §G Goal

`packages/ui` exports `Button` and `IconButton`. All 17 admin-ui files currently using raw
`btn*`/`icon-btn*` classNames render through one of these two components instead. Visual
output is equivalent to today's (same tokens, same states); the one known pre-existing CSS
inconsistency (two divergent "small primary button" rules — see §V) is resolved rather than
faithfully reproduced, and disclosed as an incidental change, same precedent as PR #288's
currency-field behavior note.

---

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | React 18, `packages/ui` (tsc-only build, no CSS/asset pipeline — see `dialog.tsx`'s doc comment)                                                                                                                                                                                                                                                                                                            |
| styling         | Inline `React.CSSProperties` referencing the design tokens already defined in `apps/admin-ui/src/index.css` (`--accent-gradient`, `--radius-sm`, `--border-color`, `--danger`, `--bg-elevated`, `--bg-tertiary`, `--text-secondary`, `--text-muted`, `--border-focus`, `--transition-fast`) — same pattern `Dialog`/`AlertDialog` already established, not Tailwind (no tailwind config exists in admin-ui) |
| dependency rule | `packages/ui` stays generic — no entity-engine/API knowledge, matches `Dialog`'s existing boundary                                                                                                                                                                                                                                                                                                          |
| out of scope    | New visual variants beyond what `btn-*`/`icon-btn-*` already cover; touching non-button CSS; `apps/portal` (removed, stub only)                                                                                                                                                                                                                                                                             |
| out of scope    | `btn-icon` (1 usage) and `btn-edit-sm` (1 usage) — ambiguous one-offs, deferred as follow-up, same precedent as #288 deferring `file`/`files`                                                                                                                                                                                                                                                               |

---

## §I Interfaces

**New exports from `@platform/ui`** (`packages/ui/src/button.tsx`, `packages/ui/src/icon-button.tsx`):

```ts
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger"; // default "secondary"
  size?: "default" | "sm"; // default "default"
}
export const Button: React.ForwardRefExoticComponent<ButtonProps>;

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "edit" | "delete" | "ghost"; // default "default"
}
export const IconButton: React.ForwardRefExoticComponent<IconButtonProps>;
```

**Current → new mapping** (verified counts, `grep -rn 'className="btn' apps/admin-ui/src`):

| current className(s)                       | count | new usage                                                                                                                                         |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `btn-primary`, `btn`+`btn-primary-sm`      | 41    | `<Button variant="primary">`                                                                                                                      |
| `btn-secondary`                            | 36    | `<Button variant="secondary">`                                                                                                                    |
| `btn` (bare)                               | 22    | `<Button variant="secondary">` (bare `.btn` today inherits secondary-like neutral styling — confirm against rendered output, not just CSS source) |
| `btn-sm` (combined with primary/secondary) | 10    | `<Button size="sm">`                                                                                                                              |
| `btn-danger-sm`                            | 2     | `<Button variant="danger" size="sm">`                                                                                                             |
| `icon-btn` + `icon-btn-edit`               | 4     | `<IconButton variant="edit">`                                                                                                                     |
| `icon-btn` + `icon-btn-delete`             | 8     | `<IconButton variant="delete">`                                                                                                                   |
| `icon-btn` + `icon-btn-ghost` / bare       | 12    | `<IconButton variant="ghost">` / `<IconButton>` (split by call site — check which modifier class each site actually pairs `icon-btn` with)        |
| `btn-icon`, `btn-edit-sm`                  | 1 + 1 | **deferred**, left as raw `<button>`                                                                                                              |

Affected files (17, all in `apps/admin-ui/src/pages/`):
`dashboard.tsx`, `records/index.tsx`, `entity-types/{detail,index,instance-detail,instance-create}.tsx`,
`modules.tsx`, `workflows/{create,detail,index}.tsx`, `automations/index.tsx`,
`automations/wizard/{wizard,step-actions,step-conditions}.tsx`, `system-logs.tsx`,
`customer/{record-list,record-detail}.tsx`.

---

## §R Requirements

**R1: `Button` renders visually equivalent output to today's `btn-primary`/`btn-secondary`/`btn`/`btn-sm`/`btn-danger-sm`**
✓ Each variant×size combination matches current computed style (color, background, padding, border-radius, hover/disabled states) within the tolerance of the CSS cleanup noted in §V
✓ `disabled` prop renders the existing disabled visual treatment (opacity 0.5, `cursor: not-allowed`)
✓ Forwards `ref`, spreads unknown DOM props (`onClick`, `type`, `aria-*`, etc.)

**R2: `IconButton` renders visually equivalent output to today's `icon-btn`/`icon-btn-edit`/`icon-btn-delete`/`icon-btn-ghost`**
✓ 30×30 circular target, same per-variant color/background/border
✓ `:active` scale-down and `:focus-visible` ring preserved
✓ `disabled` prop matches existing disabled treatment

**R3: All 17 identified files import from `@platform/ui` instead of using raw classNames**
✓ Zero remaining `className="btn` / `className="icon-btn` occurrences in `apps/admin-ui/src/pages/` after migration (`grep` returns empty)
✓ No visual regression on manual smoke pass through each touched page

**R4: `packages/ui`'s existing test convention is followed**
✓ `button.test.tsx` / `icon-button.test.tsx` added (render + variant/size prop → expected style or className assertions, matching `dialog.test.tsx`'s structure)

---

## §V Invariants

- Two divergent "small primary button" CSS rules exist today: `.btn-primary-sm` (index.css:1042,
  base `.btn` padding `7px 14px`) vs `.btn-primary.btn-sm` (index.css:2411, padding `5px 12px`).
  `Button` implements **one** canonical small-primary style (the `2411` definition — it's paired
  with the also-canonical `.btn-secondary`/`.btn-sm` block, i.e. the more complete/consistent of
  the two systems) and both call sites converge on it. This is a disclosed, intentional visual
  change, not a faithful reproduction of both — same precedent as PR #288's currency-field note.
- `packages/ui` ships no CSS/asset pipeline (tsc-only build) — new primitives must use inline
  `React.CSSProperties` referencing existing `index.css` custom properties, never introduce a
  new styling mechanism (no Tailwind, no CSS-in-JS library, no new stylesheet).

## §T Tasks

| id  | task                                                                                                                              | phase | status | depends  |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Add `Button` to `packages/ui` + `button.test.tsx`                                                                                 | 1     | todo   | —        |
| T2  | Add `IconButton` to `packages/ui` + `icon-button.test.tsx`                                                                        | 1     | todo   | —        |
| T3  | Export both from `packages/ui/src/index.ts`                                                                                       | 1     | todo   | T1,T2    |
| T4  | Migrate `entity-types/*`, `records/*`, `dashboard.tsx`, `modules.tsx`                                                             | 2     | todo   | T3       |
| T5  | Migrate `workflows/*`, `automations/*`, `system-logs.tsx`                                                                         | 2     | todo   | T3       |
| T6  | Migrate `customer/record-list.tsx`, `customer/record-detail.tsx`                                                                  | 2     | todo   | T3       |
| T7  | Remove now-dead `.btn-*`/`.icon-btn-*` CSS rules from `index.css`, leaving `btn-icon`/`btn-edit-sm`'s rules in place (still used) | 3     | todo   | T4,T5,T6 |
| T8  | Manual smoke pass (`pnpm dev`, visit every touched page) + full exit condition                                                    | 3     | todo   | T7       |

phase gate: typecheck + lint + test pass before advancing to next phase; phase 3 additionally
requires the manual smoke pass since this is a pure-CSS-visual change unit tests can't fully cover

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
