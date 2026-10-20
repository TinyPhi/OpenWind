# Tenant access gate — check a login before the dashboard

> After the Zitadel login, and before any page loads, the app asks the backend whether this
> login may use this environment. A login that may not is stopped on one screen with the
> reason, a short animation and a 5-second countdown, then fully signed out (Zitadel too) and
> returned to the login page.

status: in-progress
created: 2026-10-20
updated: 2026-10-20

---

## §G Goal

No login reaches the dashboard unless:

1. its organisation has a tenant on this environment;
2. the tenant is usable;
3. the person holds an OpenWind role.

A stopped person sees why, and is signed out cleanly so they can re-login with the right account.

## §C Constraints

| constraint   | value                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| trigger      | Owner request 2026-10-20. Local and server share one Zitadel, so a sandbox org created locally can log into the server, where no tenant exists. Every API call then answered 500 (raw org id used as a tenant id). |
| people       | Zitadel is the source of truth for people. The role check reads the token's project roles only, never the `tenant_users` cache.                                                                                    |
| platform     | `platform_admin` logins skip the tenant checks and keep their MFA flow.                                                                                                                                            |
| reuse        | The auth middleware already answers `TENANT_SUSPENDED` (403), `TENANT_NOT_FOUND` (404, deleted/purged) and `TENANT_TRIAL_EXPIRED` (403). The gate reuses these codes.                                              |
| out of scope | Replacing the `tenant_users` cache with live Zitadel reads (separate discussion). IP allow-list / rate limit / billing gates (unchanged).                                                                          |

## §I Interfaces

`GET /auth/access` (authenticated):

- `200 { data: { allowed: true, tenantId, roles } }`
- `403 { error: "NO_ROLE" }`: no OpenWind role in the token.
- Through the existing auth middleware:
  - `404 { error: "TENANT_NOT_FOUND" }`: no tenant for the org, or it was deleted/purged;
  - `403 { error: "TENANT_SUSPENDED" }`;
  - `403 { error: "TENANT_TRIAL_EXPIRED" }`.

Admin UI route: `/access-denied?reason=<code>`.

## §R Requirements

R1: An organisation with no tenant on this environment is refused cleanly.
✓ Auth middleware answers `TENANT_NOT_FOUND` (404) when the login's org maps to no tenant, in every `NODE_ENV`. It never queries `tenants` with a non-UUID id (the 500 from 2026-10-20).
✓ `DEV_TENANT_ID` keeps working for local development.
Caveat: outside production _with_ `DEV_TENANT_ID` set, a login from an org unknown to this environment still lands in the dev tenant (deliberate, for local development). R1's refusal holds wherever `DEV_TENANT_ID` is unset, which is every shared or deployed environment.

R2: The backend says whether this login may use the app.
✓ `GET /auth/access` returns allowed + tenant + roles for a login with an OpenWind role (`admin`/`agent`/`user`) in a usable tenant.
✓ It returns `NO_ROLE` (403) when the token carries none.
✓ It returns the middleware's tenant codes for missing/suspended/purged/expired tenants.

R3: The admin UI checks before the dashboard.
✓ After the Zitadel callback, and on every full page load, the app calls `/auth/access` behind a short "Checking your access…" screen before rendering any app page.
✓ `platform_admin` logins skip it.
✓ A hosted-handoff deep link passes through the same check.

R4: A refused login sees one clear screen.
✓ `/access-denied` shows the reason's message:

- `TENANT_NOT_FOUND`: "Your organisation isn't set up on this server."
- `TENANT_SUSPENDED` / `TENANT_TRIAL_EXPIRED`: "This organisation's access has ended or is blocked."
- `NO_ROLE`: "Your account hasn't been given access to OpenWind. Ask your organisation's admin."
  ✓ A small animation, the login page's support contact, and a visible 5-second countdown.
  ✓ At zero (or on "Sign out now") it signs out at Zitadel too and returns to the login page.

R5: Mid-session refusals go to the same screen.
✓ Any API response with `TENANT_NOT_FOUND`, `TENANT_SUSPENDED`, `TENANT_TRIAL_EXPIRED` or `NO_ROLE` sends the person to `/access-denied` with that reason, instead of leaving broken pages.

## §V Invariants

- No app page renders for a login whose access check hasn't passed (platform admins excepted).
- The role check never reads `tenant_users`.

## §T Tasks

| id  | task                                                                       | phase | status | depends |
| --- | -------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | R1 middleware: unmapped org → TENANT_NOT_FOUND, never a non-UUID query     | 1     | done   | —       |
| T2  | R2 `GET /auth/access` + tests                                              | 1     | done   | T1      |
| T3  | R3 admin-ui access check (callback, page load, deep link) + loading state  | 2     | done   | T2      |
| T4  | R4 `/access-denied` screen (messages, animation, countdown, full sign-out) | 2     | done   | T3      |
| T5  | R5 API-response handler → `/access-denied`                                 | 2     | done   | T4      |

## §B Bugs / Backprop Log

| id  | what failed                                                              | root cause                                                                          | promoted to §V? |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------- |
| B1  | Sandbox admin from another environment: every API call 500 on the server | non-production fallback used the raw Zitadel org id as a tenant id; no access check | yes             |

---

_spec is source of truth — update as decisions are made_
