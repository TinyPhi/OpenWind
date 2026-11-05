# 2026-11-05 — i18n phase 2 leftover string extraction (#1094, #1097, #1098, #1099, #1159)

## Context

PR #1107 extracted the first slice of phase 2 but left hardcoded English in the screens covered by
#1094, #1097, #1098 and #1099. Re-audit on main found the gaps; this change closes them.

## Done

- `App.tsx` resource labels and the `layout.tsx` avatar alt/aria-label now go through `t()`.
- `pages/schedule-rules/`, `users.tsx`, `teams/`, `services/`, `roster/`: leftover labels, dialogs, validation and error text extracted. Two keys ending in a dot (never resolvable) replaced.
- `pages/api-keys/`, `plugins.tsx`, `system-logs.tsx`, `third-party-access-logs.tsx`, `reporting.tsx`: leftover text extracted; keys the code already called but that were missing from the locales are now defined.
- `pages/platform-admin/`: `relativeTime` takes `t`; `ACTION_LABEL` and `TRIAL_BADGE` hold keys; OTP, branding, dashboard, modal and dialog strings extracted.
- All new keys added to all 11 locales as English stubs; completeness test passes.

## Known gaps

- `lib/logo-file.ts` validation messages and `hooks/use-api-key-actions.ts` copy remain English (outside the listed screens).
- `settings.test.tsx`, `language.test.ts` and `platform-admin-mfa-session.test.ts` fail locally on main as well (`localStorage` in the test environment); untouched here.
