# 2026-10-29 — Multi-lingual support Phase 2 — string extraction T10–T15 (#200)

## Done

- T10 (P2A): `layout.tsx` + `settings.tsx` — 41 keys extracted; nav, layout, settings sections
- T11 (P2B): `dashboard.tsx`, `dashboard-org.tsx`, records pages — dashboard, records sections
- T12 (P2C): `entity-types/`, `workflows/`, `automations/` — entityTypes, workflows, automations sections
- T13 (P2D): `users.tsx`, `teams/`, `services/`, `roster/`, `admin-oncall/`, `schedule-rules/`, `notification-policies/` — users, teams, services, oncall, scheduleRules, notificationPolicies sections
- T14 (P2E): `api-keys/`, `plugins.tsx`, `system-logs.tsx`, `third-party-access-logs.tsx`, `reporting.tsx`, `org-directory.tsx`, `analytics.tsx` — apiKeys, plugins, logs, reporting, orgDirectory, analytics sections
- T15 (P2F): `platform-admin/` (all tsx) + `format.ts` relative-time strings — platformAdmin, format sections
- All 10 locale stubs (hi, mr, bn, ta, te, kn, fr, de, it, es) mirrored with English values
- Test imports (`import "../i18n.js"`) added to all test files rendering i18n-enabled components
- `format.ts` refactored to accept `t: TFunction` parameter; callers updated

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (1108/1108)
- pnpm test:isolation: N/A — no new tables or routes

## Track

- Multi-lingual support (spec-driven, outside track table) — Phase 2 complete; ready to ship as PR

## Open questions

None.
