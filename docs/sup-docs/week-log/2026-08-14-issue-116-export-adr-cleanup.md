## 2026-08-14 — Issue #116 cleanup & fixes for #385, #386, #404, #405, #406

**Session type:** Docs, Bug Fixes & Code Quality
**Branch:** `fix/issues-track`

### Completed this session

#### Issue #116 (Housekeeping / Docs)

- Investigated GitHub issue **#116** regarding the carry-over ADR for the "export async design" (part of Track 2D PR #115 merged on 2026-06-18).
- Determined that writing a new ADR for the async-export design is no longer necessary or worth doing now because:
  1. The async export feature (sync ≤5k, async >5k, BullMQ job polling at `/exports/:jobId/download`) has been fully implemented, tested, and running stably in production for almost 2 months.
  2. The agent is explicitly restricted from writing or modifying ADR files autonomously in `docs/decisions/` as per the `CLAUDE.md` off-limits rules.
- Decided to close out issue #116 as stale/resolved by documentation instead.
- Updated the Track 2D specification document [2d-no-code-builders-reporting.md](file:///d:/myrepo/OpenWind/docs/specs/2d-no-code-builders-reporting.md) to accurately document the implemented async export architecture.

#### Issue #385 (Correct NOTIFICATION_PUSH_CHANNEL mock string)

- Corrected the mock string in `vi.mock` / `vi.hoisted` setup in [notification-worker.test.ts](file:///d:/myrepo/OpenWind/apps/worker/src/notification-worker.test.ts) to `"notification:push"` (matching the real exported constant instead of the typo `"notifications:push"`).
- Replaced the hardcoded `"notifications:push"` string literal in the test assertion with a reference to the imported `NOTIFICATION_PUSH_CHANNEL` constant from `@platform/redis` so future renames are caught automatically.

#### Issue #386 (Missing type-assertion comment)

- Added the required inline comment before the `as string` assertion on `instance.workflowId` inside the `sendAccessRequestToRoom` function in [notifications.ts](file:///d:/myrepo/OpenWind/apps/api/src/websocket/notifications.ts) as required by `code-style.md` ("No type assertions without an inline comment explaining why the type system can't infer it.").

#### Issues #404, #405, #406 & PR Review Hardening (Default-Privileges Over-Grants on `modules`, `tenants`, `platform_settings`, `admin_audit_log`)

- Merged the remote branch `origin/fix/PLAT-connector-definitions-default-grants` into `fix/issues-track` to pull in the migration `0060` fix for `connector_definitions` over-grant and ensure migration-sequence consistency.
- Created/updated migration `0061_app_user_default_grants_revoke.sql` to explicitly revoke over-granted default DML privileges from `app_user` on these tables:
  - **Issue #404**: Revoked `INSERT, UPDATE, DELETE` on `modules` (read-only platform catalog).
  - **Issue #405**: Revoked `INSERT, DELETE` on `tenants` (prevent unauthorized tenant creation/destruction).
  - **Issue #406**: Revoked `INSERT, DELETE` on `platform_settings` (prevent delete of the global settings row).
  - **PR Review Finding 1 (HIGH)**: Revoked `UPDATE, DELETE` on `admin_audit_log` (guarantees append-only audit trail integrity at the DB layer, preventing `app_user` from tampering with the audit logs).
- Updated `packages/db/migrations/meta/_journal.json` to register migration `0061`.
- Added new isolation tests to verify the DML restrictions on the database layer:
  - Appended INSERT and DELETE restriction tests for `platform_settings` in [platform-settings.isolation.test.ts](file:///d:/myrepo/OpenWind/apps/api/tests/isolation/platform-settings.isolation.test.ts).
  - Appended UPDATE and DELETE restriction tests for `admin_audit_log` in [audit-log.isolation.test.ts](file:///d:/myrepo/OpenWind/apps/api/tests/isolation/audit-log.isolation.test.ts) (Finding 2).
  - Created a new test file [global-catalogs-write-restrictions.isolation.test.ts](file:///d:/myrepo/OpenWind/apps/api/tests/isolation/global-catalogs-write-restrictions.isolation.test.ts) to check INSERT, UPDATE, DELETE rejections (Postgres error `42501`) on `modules` and `tenants`.

### Phase snapshot

| Track                                                         | Status                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Pre-Phase 3 hardening                                         | Complete (#125 resolved; RLS and OpenBao/MinIO/Health endpoints all clean).         |
| Unclassified (child tickets/tender/access-requests/ownership) | Closed/ratified (ADR-005/006 accepted).                                             |
| Phase 3                                                       | 3A in progress.                                                                     |
| Housekeeping                                                  | #116 resolved via spec update.                                                      |
| Code Quality / Bug Fixes                                      | #385, #386, #404, #405, and #406 fixed and verified via unit/typecheck/lint suites. |
