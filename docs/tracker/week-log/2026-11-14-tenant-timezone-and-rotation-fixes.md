# Week Log: 2026-11-14 — Tenant Default Timezone, Atomic Roster Patch & DST Calendar Arithmetic

**Date:** 2026-11-14  
**Issues Covered:** #1158, #1161, #1162  
**Branch:** `feat/PLAT-1158-tenant-timezone-and-rotation-fixes`

---

## 1. Summary of Work

### Issue #1158: Tenant Default Timezone

- **Problem**: `DEFAULT_TIMEZONE = "Asia/Kolkata"` was hardcoded in `apps/admin-ui/src/pages/schedule-rules/index.tsx`. No per-tenant organization configuration table or API existed.
- **Solution**:
  - Created `tenant_settings` table in `packages/db/src/schema/platform.ts` with tenant isolation (`tenant_isolation_policy`, migration `0164_tenant_settings.sql`).
  - Added `GET /admin/tenant-settings` (read-only org baseline for authenticated users) and `PATCH /admin/tenant-settings` (admin-only, IANA timezone validation, audit-logged as `tenant_settings.updated`).
  - Added Organization tab in Admin UI settings with Default Timezone picker and mirrored strings across all 11 locales.
  - Updated Schedule Rules wizard to load tenant default timezone dynamically on rule creation, falling back to UTC instead of hardcoded India time.

### Issue #1161: Atomic Schedule and Rotation Update

- **Problem**: Saving a schedule edit in the roster UI performed sequential HTTP PATCH requests (first `PATCH /admin/on-call-schedules/:id`, then `PATCH /admin/on-call-rotations/:id`), introducing a race condition and desync risk if either network request failed.
- **Solution**:
  - Enhanced `PATCH /admin/on-call-schedules/:id` to accept optional `rotationStatus: "active" | "stopped"`.
  - Inside a single database transaction under `withTenantContext`, locks the rotation row (`for update`), updates rotation status, releases upcoming windows if stopping, and records audit entries for both resources atomically.
  - Updated `ScheduleFormModal.handleSubmit` in `apps/admin-ui/src/pages/roster/index.tsx` to send `rotationStatus` in the schedule patch, eliminating the secondary HTTP request.

### Issue #1162: Rotation DST Calendar-Day Arithmetic

- **Problem**: Rotation calculations in `packages/teams/src/rotation.ts`, `apps/api/src/lib/rotation-windows.ts`, and `apps/admin-ui/src/pages/roster/index.tsx` used fixed `DAY_MS = 86_400_000` ms additions, causing window start/end times to drift by ±1 hour across daylight saving transitions.
- **Solution**:
  - Implemented `addCalendarDays(date, days, timeZone)` in `packages/teams/src/rotation-timezone.ts` preserving local wall-clock shift boundaries across 23h and 25h days.
  - Updated `planWindows` and `projectWindows` in `packages/teams/src/rotation.ts` to accept `timeZone?: string | null` and compute window ends via `addCalendarDays`.
  - Updated `oncall-rotation-worker.ts` and `apps/api/src/routes/admin/on-call-rotations.ts` to pass the tenant's default timezone to `planWindows` / `projectWindows`.
  - Updated `apps/api/src/lib/rotation-windows.ts` `alignRotationCursor` to recognize whole cycles with ±1 hour tolerance.
  - Updated `wholeCycleDays`, `effectiveEndsAt`, and weekly grid offset calculations in `apps/admin-ui/src/pages/roster/index.tsx`.

---

## 2. Review Follow-up & Fixes (PR #1187 Review Head `3217a85c`)

- **M1 & M2 & S4 (Schedule PATCH Atomicity & Window Deletion)**:
  - Ensured all validations (`already_started`, `end_in_past`, `bad_window`, member checks, `not_a_rotation`, `team_deleted`, `no_members`, missing rotation row) run **before** any database mutations.
  - Passed `exceptId: id` to `releaseUpcomingWindows` so stopping a rotation from an upcoming window preserves the edited window as a one-off rather than deleting it and returning 404.
  - If a schedule row vanishes during update, throws `ScheduleNotFoundError` which rolls back the transaction while mapping to HTTP 404.
- **M3 (Migration Analytics Annotation)**:
  - Added `-- analytics: excluded (tenant configuration, not business data)` to `packages/db/migrations/0164_tenant_settings.sql`, satisfying `check-analytics-annotations`.
- **G1 & S1 & S2 (DST Semantics & Host TZ Independence)**:
  - In `packages/teams/src/rotation-timezone.ts`, removed dependence on process host timezone by deriving UTC offsets purely via UTC components.
  - Implemented RFC 5545 / Temporal compatible disambiguation for spring-forward gap (advances past gap) and fall-back overlap (picks earlier occurrence).
  - Anchored window planning and projection to `input.nextStartsAt` so 1-hour gap adjustments on transition days do not permanently drift future shift handoffs.
  - Cached `Intl.DateTimeFormat` per timezone and preserved timestamp milliseconds.
- **G2 (Whole Cycle Matching)**:
  - Updated whole cycle predicate in `apps/api/src/lib/rotation-windows.ts` to `diffFromDayMultiple <= 3_600_000`, matching Admin UI roster logic and supporting 30-minute DST shifts (`Australia/Lord_Howe`) and millisecond variances.
- **G3 (Schedule Rules Modal Timezone Guard)**:
  - Guarded `tenant-settings` fetch in `ScheduleFormModal` with an ignore flag and checked `prev.timezone === "UTC"` so user-selected timezones are not overwritten by late responses.
- **G4 & G5 (Tenant Settings Audit Lock & Timezone Normalization)**:
  - Added `for("update")` row lock on before-snapshot in `PATCH /admin/tenant-settings`.
  - Skipped writing duplicate audit entries on no-op saves.
  - Canonicalized timezone strings via `Intl.DateTimeFormat.resolvedOptions().timeZone` and rejected invalid/inverted `Etc/GMT` zones.
- **S5 & S6 (i18n & Roster UI Local Timezone)**:
  - Documented that Roster UI displays and calculates in the local operator's browser timezone. Translation follow-ups for non-English `settings.*` keys are tracked under #200.

---

## 3. Test Coverage

- **Isolation Tests**: `apps/api/tests/isolation/tenant-settings.isolation.test.ts` (verifies cross-tenant RLS enforcement).
- **Unit Tests**:
  - `packages/teams/src/rotation-timezone.test.ts` (15 tests passing across Spring forward gap, Fall back overlap, Lord Howe 30m DST, Sydney, Kathmandu 45m, Havana midnight, millisecond preservation, 1-day/3-day transition cycles).
  - `packages/teams/src/rotation.test.ts` (28 tests passing, including anchored multi-window transitions without permanent drift).
  - `apps/worker/src/oncall-rotation-worker.test.ts` (7 tests passing, verifying tenant timezone propagation).
  - `apps/api/src/routes/admin/tenant-settings.test.ts` (10 tests passing, including canonicalization and no-op audit skipping).
  - `apps/api/src/routes/admin/on-call-schedules.test.ts` (38 tests passing, covering M1/M2 atomicity and `exceptId`).
  - `apps/api/src/routes/admin/on-call-rotations.test.ts` (23 tests passing, covering tenant timezone projection).
  - `apps/admin-ui/src/pages/settings.test.tsx` (5 tests passing).
  - `apps/admin-ui/src/pages/schedule-rules/index.test.tsx` (24 tests passing, covering G3 async race conditions).
  - `apps/admin-ui/src/pages/roster/index.test.tsx` (27 tests passing).
  - `apps/admin-ui/src/locales/locale-completeness.test.ts` (22 tests passing with 100% key parity across all 11 locales).
