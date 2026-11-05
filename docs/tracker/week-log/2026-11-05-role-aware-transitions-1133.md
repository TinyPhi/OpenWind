# 2026-11-05 — Role-aware transitions in record detail and kanban (#1133)

## Done

- `record-detail.tsx`: the state menu renders the list from `GET /entities/:id/transitions` (role and condition aware), refetched whenever the record's state changes. If the call fails it falls back to the workflow's full list; the server still enforces roles and conditions.
- `workflow-records.tsx`: kanban drop targets and the drop handler ignore transitions whose `allowedRoles` exclude the viewer's roles, via the new `lib/transition-roles.ts` helper. Conditions stay server-side: they need the record and the actor, and a per-card call would be N requests.
- Tests: three record-detail tests (only permitted shown, none shown, fallback on failure) and unit tests for the role filter. No kanban drag test: the drag state is module-level and the suite has no drag tests, so the filter is covered as a pure helper.
- `docs/runbooks/vendor-approval-walkthrough.md`: gap 1 marked fixed.

## Verification

- admin-ui tsc and eslint clean; vitest 1192 passed, 22 failed in `language.test.ts`, `settings.test.tsx` and `platform-admin-mfa-session.test.ts`, which fail the same way on main (`localStorage` in the local test env).
