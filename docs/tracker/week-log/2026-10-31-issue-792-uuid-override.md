## 2026-10-31 — #792 uuid override (GHSA-w5hq-g745-h8pq)

### Done

- Added `uuid: ">=11.1.1 <12"` to `overrides:` in `pnpm-workspace.yaml` with advisory + rationale
  comment; removed the stale Deferred bullet (it wrongly said uuid 11 dropped CommonJS; it ships
  CJS, uuid 12+ is ESM-only, hence the `<12` cap). Lockfile regenerated: only uuid 8.3.2 -> 11.1.1.
- Advisory is not reachable: only exceljs@4.4.0 (`cf-rule-ext-xform.js`) calls `v4()`, with no `buf`.
- Added an exceljs conditional-formatting round-trip test in `apps/worker/src/export-worker.test.ts`.
- Checked the same round-trip under plain Node CJS (the apps compile to CJS): uuid 11.1.1, `v4()`
  hit once, workbook reloaded intact. apps/api and apps/worker `dist` both `require("exceljs")`.

### Verification

- pnpm install --frozen-lockfile: PASS; pnpm why uuid: only 11.1.1; pnpm audit: uuid advisory gone
- pnpm typecheck: PASS (52/52); pnpm lint: PASS (52/52)
- pnpm test: only worker DB isolation tests fail locally (DB password auth, local drift)
- pnpm test:isolation: worker DB-backed suites fail locally on password auth, unrelated

### Next

- exceljs staleness (last release Dec 2024) is a separate follow-up; drop the pin if exceljs moves.
