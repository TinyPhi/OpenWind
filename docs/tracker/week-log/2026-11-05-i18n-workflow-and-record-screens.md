# 2026-11-05 — i18n extraction for record and workflow screens (#1116, #1117, #1118)

## Done

- `pages/customer/record-detail.tsx` and `record-create.tsx` (#1116): 307 keys under `recordDetail` / `recordCreate`. Embedded-markup sentences (activity feed, archive, link and transition text) use `<Trans>`; counts use `_one/_other`.
- `components/workflow-canvas.tsx` (#1117): 30 `workflowCanvas.*` keys. `workflows/detail.tsx` and `workflows/index.tsx` had leftovers fixed; `workflows/create.tsx` was already done. A language-dependent comparison (`row.label === "Workflow ID"`) now uses the translated label.
- `pages/records/workflow-records.tsx` (#1118): 43 `workflowRecords.*` keys.
- All new keys added to all 11 locales as English stubs; completeness test passes.

## Known gaps

- Shared components imported by these pages still hold English: `severity-tag` (`SEVERITY_LABEL`/`SEVERITY_LEVELS`), `origin-tag`, the file upload/preview chips, `CoverageGapBadge`, `NotificationFailureBadge`, `TicketLabelsPanel`; the shared `relativeTime` in `lib/format.ts`. These belong to #1119.
- `settings.test.tsx`, `language.test.ts` and `platform-admin-mfa-session.test.ts` fail locally on main as well (`localStorage` in the test env); untouched.
