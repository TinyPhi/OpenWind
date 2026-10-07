# ADR-022: Platform Admin — Cross-Tenant Sandbox Lifecycle Role

**Status:** Proposed — revised after @PrabhuVijit's review; blockers addressed below, pending re-review.
**Date:** 2026-10-06
**Deciders:** Tushar Sharma (Engineering Lead). Reviewed by: @PrabhuVijit.
**Related to:** ADR-001 (multitenancy/RLS — this role is the first intentional exception to
"every request resolves to exactly one tenant"), ADR-004 (config-first — unaffected, no module
code involved), ADR-013 (unified rate-limiting strategy), `docs/specs/multi-org-sandbox.md` (the
spec this ADR unblocks).
**Supersedes:** —
**Superseded by:** —

---

## Context

### Problem — sandbox provisioning needs a role no customer tenant should ever have

The Multi-Org Sandbox System (spec: `docs/specs/multi-org-sandbox.md`) lets an internal operator
spin up, reset and delete on-demand trial organizations for prospects. Every existing role in
OpenWind (`admin`, `agent`, `user`) is tenant-scoped: a token carries (or resolves to) exactly one
`tenant_id`, and every query, RLS policy and route assumes that. This feature needs an operator
who can act _across_ tenants — create a new one, read lifecycle metadata about several, delete
one — without ever being scoped to any single tenant's business data.

No such role exists today. This is new architectural surface, not a variation on an existing
pattern, which is why CLAUDE.md requires a dedicated ADR before any code lands.

### What's already decided (not open for re-litigation here)

Settled across three `/interview-me` rounds and an external review from @PrabhuVijit:

- Platform admin is issued by Zitadel as a role claim, same OIDC mechanism as every other role.
- Dedicated `/platform-admin` login route, separate dashboard, required MFA (see Decision 1's
  addendum below — the mechanism changed from the originally planned Zitadel TOTP).
- Powers limited to: create / list / read-metadata / reset / delete sandboxes. Never business
  data (tickets, org chart contents, audit entries).
- `tenants.is_sandbox` flags sandboxes for internal tooling.
- Full detail: `docs/specs/multi-org-sandbox.md` (now present in this repo — see Decision 4).

### What THIS ADR must actually decide

How does a `platform_admin` request reach Postgres and read/write across tenants, given RLS is
enforced via `SET LOCAL ROLE app_user` plus a tenant-scoped GUC (`packages/db/src/client.ts`)?

---

## Decision

### Decision 1 — RLS / cross-tenant write mechanism

**Option B** — a separate, narrowly-scoped Postgres role (`platform_admin_role`) used only by
`platform_admin`-reachable routes, with column-level GRANTs on exactly the lifecycle-metadata
columns of `tenants` (name, created_at, is_sandbox, trial_ends_at) and no SELECT/INSERT/UPDATE
grant on any business-data table (entity_instances, workflow tables, audit tables, etc.) at all.

No new RLS policy logic is added to existing tables. The guarantee comes from Postgres GRANT
permissions, not from a policy condition that has to be remembered per table.

**Why, over an RLS-policy-condition approach (Option A):** route separation (a dedicated
`/platform-admin/*` route tree, never shared with `admin`/`user` routes) already prevents the
wrong _role_ from hitting the wrong _route_. This decision is the layer underneath that: it
prevents a bug in a platform-admin route's own code from accidentally reading business data
anyway. A GRANT-level restriction fails with a hard database permission error in that case,
regardless of what the route code intended. An RLS-policy-condition approach would instead
depend on every table's policy correctly excluding platform-admin by omission — safe by default
today, but more fragile over time as new tables get added by copying existing policies as
templates.

**Cost accepted:** a second Postgres role/connection pattern, and every future metadata field
exposed to platform-admin needs its own explicit GRANT rather than falling out of the existing
tenant-scoped query path for free.

**Implemented** (PR1, `feat/sandbox-01-platform-admin-foundation`): migration
`0134_platform_admin_sandbox_columns.sql` creates `platform_admin_role` with
`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, column-scoped `GRANT SELECT` on
exactly `id, name, created_at, is_sandbox, trial_ends_at, created_by_platform_admin`, and
`GRANT platform_admin_role TO app_user WITH INHERIT FALSE` — the `WITH INHERIT FALSE` is
load-bearing: a plain `GRANT` (no inherit clause) would have let every ordinary tenant-scoped
`app_user` session passively inherit `platform_admin_role`'s privileges with no `SET ROLE` at
all, found and fixed during security review. Regression-guarded by
`apps/api/tests/isolation/platform-admin-role.isolation.test.ts` against a real Postgres
(confirms the role cannot SELECT from `entity_instances`, cannot SELECT a non-allow-listed
`tenants` column, and that the inherit flag is `false`).

### Decision 2 — Where the role claim is recognized in the auth path

**Resolved: Option B.** `org_id` is never read for a `platform_admin` token — not validated,
not rejected, simply never consulted. `packages/auth`'s `extractPlatformAdminContext`
(`packages/auth/src/jwks.ts`) builds the platform-admin identity from `sub` and the
`platform_admin` project-role claim only; it has no `tenantId` or `orgId` field at all (see
`PlatformAdminAuthContext` in `packages/auth/src/types.ts`), so there is no code path that could
accidentally key off a spoofed `org_id` value. `requirePlatformAdminIdentity`/`requirePlatformAdmin`
(`packages/auth/src/middleware.ts`) are built on a separate code path from `requireAuth`
entirely — tenant-resolution (`lookupTenantIdByOrgId`) is never called, not bypassed inside a
shared function.

### Decision 3 — Response-shape containment

**Resolved and implemented.** Every `platform_admin`-reachable route returns through
`PlatformAdminSandboxView` (`packages/db/src/platform-admin-view.ts`), built only by
`toPlatformAdminSandboxView()` — never a direct Drizzle query-result passthrough. The type is a
fixed allow-list (`id`, `name`, `isSandbox`, `createdAt`, `trialStatus`); widening it is itself
the explicit, reviewable act that widening platform_admin's visibility requires. Verified by
`apps/api/src/routes/platform-admin/session.test.ts`, which asserts the response never carries a
`tenantId` field.

### Decision 4 — Sign-off that the spec's invariants are sufficient

`docs/specs/multi-org-sandbox.md` now exists in this repo (added alongside this revision,
resolving the prior review's blocker that this ADR referenced a non-existent file). Its §V states
the invariants this ADR's acceptance signs off on; enumerated here directly so this ADR is
self-contained for `/security-review`, per review feedback:

- A `platform_admin`-authenticated request never resolves to, or is scoped by, any single
  tenant's `tenant_id`.
- No route reachable by `platform_admin` ever returns business data — only lifecycle metadata,
  enforced by both the DTO allow-list (Decision 3) and the database-layer GRANT (Decision 1) —
  two independent layers, not one.
- Trial-expiry status is always computed live from `trial_ends_at`, never cached as a stale
  boolean.
- A sandbox's seeded accounts are real, working Zitadel accounts — never a parallel/fake identity
  mechanism.
- `app_user`'s membership in `platform_admin_role` is always `WITH INHERIT FALSE`.
- Exactly one lifecycle action (reset/delete) may be in flight per sandbox tenant at a time.
- A Redis outage or error while checking platform-admin MFA verification always fails closed.

### Decision 5 — Connection pool / role-switching pattern

**Resolved.** No second connection string or pool. `packages/db/src/middleware.ts`'s
`withPlatformAdminContext()` issues `SET LOCAL ROLE platform_admin_role` inside a transaction on
the same pool `withTenantContext` already uses (mirrors the existing `setOutboxSweeperRole`/
`setScheduleSweeperRole` pattern for other narrowly-scoped roles in this codebase). Every
`platform_admin`-reachable route must read through this helper, never the plain `db` export or
`withTenantContext` — using plain `db` would run as whatever role owns the pool connection
(often a superuser in local/dev), bypassing the restriction entirely.

### Decision 6 — SECURITY DEFINER exposure

`platform_admin_role` is granted no `EXECUTE` on any function, `SECURITY DEFINER` or otherwise —
only the column-scoped `SELECT` on `tenants` described in Decision 1. This repo does not
currently define any `SECURITY DEFINER` function reachable from the `public` schema that
`platform_admin_role` has `USAGE` on (it has schema `USAGE`, not blanket execute rights). Any
future migration granting `platform_admin_role` `EXECUTE` on a function must be reviewed against
this decision specifically — a `SECURITY DEFINER` function's privileges aren't bounded by the
caller's own GRANTs.

### Decision 7 — Audit trail for cross-tenant platform-admin actions

**Not yet implemented — tracked as Phase 3, T16 in the spec.** The existing `admin_audit_log` is
tenant-scoped (every row requires a `tenant_id`); a platform-admin action doesn't resolve to one
tenant the way every other audited action does (most clearly for a failed-or-in-progress create,
which has no tenant yet). Leading option (per review feedback, not yet built): a dedicated
`platform_admin_audit_log` table — `actor_sub` (Zitadel user id), `action`
(`sandbox.created`/`sandbox.deleted`/`sandbox.reset`), `target_tenant_id`, `created_at`. No RLS
(it is platform-level, not tenant data); readable only by `platform_admin`-reachable routes
guarded the same way as every other route in this role's surface. Per the spec's R9, only
_completed_ actions are recorded — a failed or abandoned attempt is visible to the platform admin
live via the provisioning-progress UI (R5), not duplicated into a separate audit entry. This
decision must be finalized before T16 is implemented; recorded here as an open item rather than a
silent gap.

### Decision 8 — Rate limiting on `/platform-admin/*`

Two independent layers, consistent with ADR-013's unified rate-limiting strategy: the global
per-IP `rateLimit()` middleware (mounted on `*`, `apps/api/src/app.ts`) applies to every
`/platform-admin/*` route same as any other route, and `platform-admin-mfa.ts`'s own
`MAX_VERIFY_ATTEMPTS = 5`-within-a-10-minute-TTL caps brute-force guessing against one admin's
OTP specifically (a per-IP limit alone wouldn't stop distributed guessing against one target).
No additional per-operation rate limit (e.g. a cap on sandbox deletions per minute) exists yet —
tracked as a Phase 3 consideration alongside T16's audit trail, not a Phase 1 blocker since a
compromised session's blast radius is already bounded by R11's per-admin sandbox quota.

### Decision 9 — "Reset" is defined in the spec, cross-referenced here

Per `docs/specs/multi-org-sandbox.md` R7: reset wipes and re-seeds only module/business data
(tickets, workflow instances, automation-execution history) — org chart, accounts, and
credentials are untouched. It is not a `DROP CASCADE` or a full re-provision. Concurrent
reset/delete on the same sandbox is rejected (409), not interleaved, enforced by a per-sandbox
lock (§V, Decision 4's enumerated invariants) — tracked as T22 in the spec, not yet implemented.

---

## Consequences

**Enables:** Phase 1 of `docs/specs/multi-org-sandbox.md` — already implemented (PR1,
`feat/sandbox-01-platform-admin-foundation`) can be raised as a real PR once this ADR is
accepted. Phase 2/3 work (provisioning, lifecycle, dashboard, audit trail) starts only after
Decision 7 (audit trail) is finalized, not automatically on this ADR's acceptance.

**Risk if mechanism is under-specified:** this is the single highest-risk element of the whole
feature — the one piece of code allowed to deliberately cross the tenant-isolation boundary every
other ADR in this repo treats as absolute. `/security-review` has already run once against PR1's
implementation and found one real issue (the `WITH INHERIT FALSE` gap, Decision 1) — fixed and
regression-tested before commit.

**Follow-up:** `/spec-tasks` runs for real against `docs/specs/multi-org-sandbox.md` once this
ADR is accepted, to freeze Phase 2's plan-lock.

---

## Alternatives considered

| alternative                                                                           | rejected because                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Give `platform_admin` the normal `admin` role plus a special tenant_id sentinel value | Still fundamentally tenant-scoped machinery bent sideways; every RLS policy and route would need to special-case the sentinel                           |
| A separate microservice/admin tool outside the main API                               | Doubles the auth surface, duplicates the Zitadel integration, complicates "works identically local + server"                                            |
| Let `platform_admin` read business data too, just log it heavily                      | R2's limitation to lifecycle-only metadata was a deliberate scope cut to keep blast radius small; logging a bigger power is weaker than not granting it |
