# 2026-10-20 — Tenant access gate: check a login before the dashboard

**Session type:** feature (docs/specs/tenant-access-gate.md)
**Branch:** `feat/tenant-access-gate` (off `main`)

- **Trigger.** Local and the test server share one Zitadel. A sandbox admin created locally
  logged into the server, where that org has no tenant: the app went straight to the dashboard
  and every API call answered 500. Outside production, the auth middleware fell back to the raw
  Zitadel org id as a tenant id.
- **Backend.**
  - An unmapped org now gets `TENANT_NOT_FOUND` (404) in every `NODE_ENV`. The non-production
    fallback is used only when it's a real tenant id (`DEV_TENANT_ID`).
  - New `GET /auth/access` answers "allowed" plus tenant and roles, or `NO_ROLE` (403) when the
    token carries no OpenWind role (`admin`/`agent`/`user`/`superadmin`).
  - Tenant refusals (`TENANT_NOT_FOUND`, `TENANT_SUSPENDED`, `TENANT_TRIAL_EXPIRED`) come from
    `requireAuth()` as before. Roles are read from the token only (Zitadel is the source of
    truth for people), never the `tenant_users` cache.
- **Admin UI.**
  - `AccessGate` wraps every app page. It asks `/auth/access` once per page load, behind
    "Checking your access…", before anything renders or loads tenant data. If the check itself
    fails it offers a retry. Platform admins skip it (separate route tree).
  - The four refusal codes, from any API call (mid-session included), send the browser to
    `/access-denied?reason=…`. Platform-admin pages are left alone.
  - `/access-denied` shows the reason, an animated lock with a draining ring, a support
    contact, and a 5-second countdown. At zero (or "Sign out now") it signs out at Zitadel
    too, so the next login can pick another account, then lands on the login page.
- **Tests.**
  - Auth middleware (refuses an unmapped org; fixtures moved to real tenant UUIDs, since the
    old fallback accepted any string).
  - `/auth/access` roles.
  - Refusal routing in `fetchWithAuth` / `fetchRawWithAuth` and `redirectToAccessDenied`.
  - The gate (checking, once per load, refusal stays hidden, retry).
  - The access-denied screen (messages, countdown, sign-out once, offline fallback, contact
    link).
