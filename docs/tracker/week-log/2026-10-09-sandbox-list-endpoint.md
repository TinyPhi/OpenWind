# 2026-10-09 — sandbox list/detail endpoints (T19 wiring, T17 backend prerequisite)

**Session type:** Feature implementation
**Spec:** `docs/specs/multi-org-sandbox.md` T19, T17 prerequisite
**Branch:** `feat/sandbox-11-list-endpoint`

- Scoped T17 (platform-admin dashboard) via an Explore pass and found a real gap:
  `PlatformAdminSandboxView`/`toPlatformAdminSandboxView` (T19) were built but nothing
  read through them — `apps/api/src/routes/platform-admin/sandboxes.ts` only had
  create/progress-by-jobId/handover-by-jobId, no list-all or single-by-tenantId route.
  The dashboard's list view can't exist without one.
- New `apps/api/src/routes/platform-admin/sandboxes-list.ts`: `GET /platform-admin/sandboxes`
  (every sandbox, newest-first) and `GET /platform-admin/sandboxes/:tenantId` (single, 404
  for a non-sandbox or missing tenant — security.md's 404-not-403 rule). Both select only
  the column set `platform_admin_role` is actually granted (migration 0135) and return
  through the existing `toPlatformAdminSandboxView` DTO — no schema change, no new grant.
- 4 new unit tests (list with rows, empty list, single sandbox, 404). All 6
  `platform-admin/*` test files (42 tests total) still pass.
- Admin-ui dashboard itself (T17 proper) is a separate, larger piece of work — confirmed
  via the same Explore pass to be fully greenfield (zero existing platform-admin code in
  `apps/admin-ui`), with its own open questions (MFA-flow UX, auth-provider branching,
  routing split from the normal tenant-admin shell) to work through before implementation.
