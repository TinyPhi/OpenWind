## 2026-09-27 — #638 export audit trail

**Session type:** GDPR/security fix, api + worker + one constraint migration
**Branch:** `fix/PLAT-638-export-audit-trail`, stacked on #681 (`fix/PLAT-635-gdpr-erasure-coverage`)
**Spec:** `docs/specs/export-audit-trail.md`

### Done

- **New audit actions.** Migration 0126 adds `export.requested`, `export.completed` and
  `export.failed` to `audit_log_action_check`, and `AuditAction` gains the same three.
- **Route (`entity-types/export.ts`).**
  - `export.requested` is written before any data leaves, on both paths. The export fails if
    that write fails.
  - Sync path: `export.completed` on a successful render, `export.failed` on a render error.
  - Async path: the job id is pre-generated so the request entry names it, and a failed enqueue
    is audited as `export.failed`.
- **Worker.** `processExportJob` writes `export.completed`, or `export.failed` on a throw or a
  deactivated tenant, then rethrows.
- **Entry contents.** Every entry records format, filters, row count, mode, job id and
  `includePii`. Never row values.

### Verification

- Route unit tests: 27, including the new audit assertions (the issue's AC).
- Worker processor tests: 5 new.
- New isolation test: a real sync export writes the rows for its own tenant only, and the
  CHECK constraint still rejects unknown actions.
- Migrations applied cleanly on a fresh database.

### Merge order

Stacked on #681 because both add migrations (0125, 0126). The migrator skips a migration older
than the newest one applied, so #681 must merge first.
