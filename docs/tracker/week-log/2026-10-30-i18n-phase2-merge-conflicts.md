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

### Next (second merge round — PRs #1103, #1105, #1106)

- Second `git merge origin/main` incorporating PRs #1103, #1105, #1106:
  - 23 merge conflicts resolved
  - `teams/index.tsx`: kept our `t()` calls + incorporated main's `MemberListEditor`
    (member list with rotation order); extracted new strings:
    `teams.membersLabel`, `teams.noMembers`, `teams.addMember`, `teams.addMemberPlaceholder`,
    `teams.removeMember` (with `{{name}}`), `teams.moveUp`, `teams.moveDown`, `teams.failedToLoadUsers`
  - `roster/index.tsx`: kept our `t()` calls + incorporated main's team picker in the
    schedule form (`teams/defaultTeamId` props, `chosenTeamId` state, `changeTeam` logic);
    extracted: `roster.team`, `roster.unknownTeam`, `roster.noMembersHint`
  - `teams.editTeam` / `teams.deleteTeam` updated to lowercase to match test expectations
  - All 10 locale stubs mirrored
  - Fixed `teams.map((t) => ...)` → `teams.map((team) => ...)` variable shadowing in `roster/index.tsx`
  - `record-detail.tsx` hardcoded strings deferred — 5906-line file, not in scope of phase 2
- Verification: typecheck PASS, lint PASS, admin-ui 108/108 files 1144/1144 tests PASS

### Open questions

- `record-detail.tsx`: 3 hardcoded strings (`"The comment could not be posted"` ×2,
  `"Waiting for file scan…"`) not extracted — deferred to a follow-up i18n pass on that file
