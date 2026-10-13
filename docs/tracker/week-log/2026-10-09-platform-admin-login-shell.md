# 2026-10-09 — platform-admin login/MFA/dashboard shell (T17 slice 1)

**Session type:** Feature implementation
**Spec:** `docs/specs/multi-org-sandbox.md` T17 (slice 1 of 2)
**Branch:** `feat/sandbox-12-platform-admin-login`

- Confirmed via an Explore pass that `platform_admin` needs zero new frontend auth
  mechanism: `packages/auth/src/jwks.ts`'s `extractPlatformAdminContext` and
  `authProvider.ts`'s `getPermissions()` both do the identical
  `Object.keys(rolesMap)` check against the same Zitadel roles claim, so the existing
  OIDC sign-in already surfaces `platform_admin` as a role with no change.
- New `RequirePlatformAdmin` guard (role-only, mirrors `RequireAdmin`) and
  `RequirePlatformAdminMfa` guard (calls `GET /platform-admin/session` — the same
  `requirePlatformAdmin` middleware every other platform-admin route runs behind, so
  there's no separate client-side MFA-verified flag that could drift from the server's
  Redis-backed one).
- New `/platform-admin/login`, `/platform-admin/mfa`, `/platform-admin/dashboard` pages,
  mounted as their own top-level route tree in `App.tsx` — entirely outside the tenant
  `<Authenticated>`/`Layout`/`EntityTypeProvider` shell, so a platform admin never sees
  the tenant sidebar.
- Found and fixed mid-implementation: the shared OIDC callback (`pages/callback.tsx`)
  unconditionally navigated to the tenant `/dashboard` after any successful sign-in —
  would have broken platform-admin login entirely. Now checks the roles claim first
  (same parsing as `authProvider.ts`) and routes to `/platform-admin/dashboard` when the
  role is present.
- Dashboard itself is a placeholder (identity + logout) — the actual sandbox
  list/create/reset/delete/handover UI is a separate, later slice, built on top of T19's
  now-wired `GET /platform-admin/sandboxes` list/detail endpoints (PR12).
- New tests: 4 (`RequirePlatformAdmin`), 4 (`RequirePlatformAdminMfa`), 5 (login page),
  5 (MFA page), 3 (dashboard page), plus 2 new cases added to the existing
  `callback.test.tsx` (platform_admin routes correctly, non-platform_admin unaffected).
- Deliberately skipped: a full `App.tsx` integration test. The route-isolation guarantee
  (platform-admin routes never render inside the tenant shell) is structural (code
  placement, reviewable directly) and already covered behaviorally by the guard/page unit
  tests; mocking Refine's entire provider stack for one assertion wasn't worth the
  brittleness it would add.
