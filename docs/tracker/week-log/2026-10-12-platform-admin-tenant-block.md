# 2026-10-12 — block platform_admin from tenant routes and the tenant UI shell

**Session type:** Security fix (found in manual testing)
**Spec:** `docs/specs/multi-org-sandbox.md` R1, R2 (§B B3)
**Branch:** `feat/sandbox-15-platform-admin-tenant-block`

- While manually testing the platform-admin dashboard, a page refresh left the platform admin
  in the tenant admin-ui shell. The backend request log showed the tenant shell's requests
  succeeding with the platform_admin token: `GET /entity-types`, `/modules` and
  `/dashboard/my-view` returned 200 (the dev tenant's data, via `DEV_TENANT_ID`); only routes
  behind `requireRole("admin"|"agent"|"user")` returned 403. In production the same token would
  resolve to whichever tenant its Zitadel org maps to. This broke R1 (never the tenant shell)
  and R2 (no business data) — the existing DTO allow-list and column GRANT only protect
  `/platform-admin/*`. The exact navigation that triggered the jump couldn't be pinned down from
  logs; the fix closes every path rather than one.
- Backend: `requireAuth` now rejects any token carrying `platform_admin` with
  `403 PLATFORM_ADMIN_TENANT_ACCESS_DENIED` before tenant resolution (403 rather than 401 so the
  UI doesn't refresh-then-logout). `extractAuthContext` also returns null for such tokens,
  covering the notifications WebSocket, the only other JWT entry point. Shared
  `isPlatformAdminToken` check in `packages/auth/src/jwks.ts`.
- Frontend: new `RejectPlatformAdmin` wraps the tenant shell inside `<Authenticated>` and
  redirects a platform_admin to `/platform-admin/dashboard` before `EntityTypeProvider`/`Layout`
  mount, so no tenant request fires.
- Accounts holding both `platform_admin` and a tenant role are now locked out of the tenant UI
  and API — intended per R1 (separate identity); platform admins need a separate Zitadel account
  for tenant work.
- Tests: 2 `requireAuth` cases (pure and dual-role token → 403, handler and tenant extraction
  never reached), `extractAuthContext` returns null for platform_admin, 4 `RejectPlatformAdmin`
  cases (including "tenant shell never mounts"), and `fetchWithAuth` treats this 403 as a
  refusal, not an expired session.
