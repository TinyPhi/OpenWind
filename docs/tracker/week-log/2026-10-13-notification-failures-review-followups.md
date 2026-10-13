# 2026-10-13 — #885 review follow-ups (#900, #901, #902)

**Session type:** Code
**Branch:** `fix/PLAT-901-notification-failures-followups`

- #901: `GET /entities/:id/notification-failures` now validates `:id` as a uuid with the shared `zValidator` wrapper, after the auth and role gates. A malformed id gets the standard 400 validation envelope before any database work, instead of a Postgres error that happened to be caught. The isolation test now expects 400 and still asserts no database error text in the body.
- #900: added the inline comments the code-style rule requires on the two `as` assertions in `parseFailures`.
- #902: the isolation test's `afterAll` now also deletes the entity type it creates with a null `tenant_id`, which the per-tenant deletes never matched (one leaked row per run).
