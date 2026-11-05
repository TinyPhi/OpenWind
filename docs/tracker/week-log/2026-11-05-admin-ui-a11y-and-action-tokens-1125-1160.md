# 2026-11-05 — SearchableMultiSelect ARIA and action-icon colour tokens (#1125, #1160)

## Done

- #1125: `SearchableMultiSelect` trigger has `aria-haspopup="listbox"`; the list is `role="listbox"` with `aria-multiselectable`; each row is `role="option"` with `aria-selected`. Component test added.
- #1160: `CircleActionButton` background and icon colours moved from hardcoded HSL/hex in `action-icons.tsx` to `--action-<colour>-bg` / `--action-<colour>-icon` custom properties on `:root` in `index.css`. Values are unchanged and identical in both themes.

## Verification

- `src/components` vitest: 162/162; tsc and eslint clean for admin-ui.
