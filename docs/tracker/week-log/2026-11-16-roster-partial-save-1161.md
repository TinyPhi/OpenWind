# 2026-11-16 — On-call roster partial-save handling (#1161)

## Done

- `apps/admin-ui/src/pages/roster/index.tsx`: when the window PATCH succeeds but the follow-up rotation PATCH (pause/resume) fails, the form now calls a new `onPartialSave` (refresh schedules and rotations without closing), stays open, and shows a retry message that includes the failure cause. This is option 3 from the issue; no API change.
- Added the `roster.windowSavedRepeatFailed` string to every locale (English text in non-English locales, matching the existing pattern for new keys).

## Not done

- #1162 (DST-safe rotation cycle end) is not fixed here. The issue's fix needs the tenant timezone, which does not exist yet (no `tenant_settings.timezone`; it arrives with #1158). Server arithmetic lives in `apps/api/src/lib/rotation-windows.ts` and `packages/teams/src/rotation.ts`; the UI side in `roster/index.tsx`. Needs a decision on whether to land #1158 first.

## Verification

- Roster tests: 28/28 pass; the new #1161 regression test fails against the old code and passes with the fix.
- `pnpm --filter admin-ui typecheck` and `lint`: PASS.
- Full admin-ui suite: `login.test.tsx` and `settings.test.tsx` fail (24 tests) identically on unmodified main; unrelated to this change.
- `pnpm test:isolation`: N/A, no API, DB or route change.
