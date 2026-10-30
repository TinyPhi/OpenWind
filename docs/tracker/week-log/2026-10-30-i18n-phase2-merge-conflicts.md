## 2026-10-30 — i18n phase 2: merge conflicts + abmish review

### Done

- Merged main into `feat/PLAT-200-i18n-phase2` after #1102 squash-merged as `5466df0`:
  - 10 locale JSON conflicts → `git checkout --ours` (keep our i18n keys)
  - `settings.tsx` / `dashboard.tsx` conflicts → `git checkout --ours` (keep our `t()` calls)
  - `CHANGELOG.md` conflict → `git checkout --theirs` (add main's erase-user + superset-erasure sections)
- Extracted strings from new code that landed in main since phase 2 started:
  - `toast.tsx` — `aria-label="Dismiss"` → `t("toast.dismiss")`
  - `confirm-delete-dialog.tsx` — default title, confirm/busy labels, type-to-confirm copy
  - `users.tsx` — full erase-user flow (button, aria-label, dialog, success/incomplete/failure toasts)
  - `sandbox-row-actions.tsx` — "Seed org chart" menu item + confirm dialog via `t()`
- Fixed variable shadowing bug in `toast.tsx`: `toasts.map((t) => ...)` renamed to
  `toasts.map((toast) => ...)` — `t` was shadowing the `useTranslation` TFunction
- Added `import "../i18n.js"` to `toast.test.tsx` and `confirm-delete-dialog.test.tsx`
- All locale stubs (hi, mr, bn, ta, te, kn, fr, de, it, es) mirrored with new keys

### Verification

- pnpm typecheck: PASS (52/52)
- pnpm lint: PASS (52/52, --max-warnings=0)
- pnpm test: PASS (admin-ui 108/108 files, 1125/1125 tests)
- pnpm test:isolation: N/A — Docker not running on Windows; no new tables or routes

### Next

- Commit and push; confirm PR #1107 CI green after retarget to main

### Open questions

- None
