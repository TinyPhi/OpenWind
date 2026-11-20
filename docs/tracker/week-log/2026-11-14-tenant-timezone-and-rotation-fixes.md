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

## 2. Test Coverage

- **Isolation Tests**: `apps/api/tests/isolation/tenant-settings.isolation.test.ts` (verifies cross-tenant RLS enforcement).
- **Unit Tests**:
  - `packages/teams/src/rotation-timezone.test.ts` (6 tests across Spring forward, Fall back, and leap years).
  - `packages/teams/src/rotation.test.ts` (27 tests passing).
  - `apps/worker/src/oncall-rotation-worker.test.ts` (5 tests passing).
  - `apps/api/src/routes/admin/tenant-settings.test.ts` (7 tests passing).
  - `apps/api/src/routes/admin/on-call-schedules.test.ts` (36 tests passing, including atomic rotation status updates).
  - `apps/api/src/routes/admin/on-call-rotations.test.ts` (22 tests passing).
  - `apps/admin-ui/src/pages/settings.test.tsx` (5 tests passing).
  - `apps/admin-ui/src/pages/schedule-rules/index.test.tsx` (23 tests passing).
  - `apps/admin-ui/src/pages/roster/index.test.tsx` (27 tests passing).
  - `apps/admin-ui/src/locales/locale-completeness.test.ts` (22 tests passing with 100% key parity across all 11 locales).
