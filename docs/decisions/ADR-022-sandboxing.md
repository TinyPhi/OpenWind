# ADR-022: Platform Admin — Cross-Tenant Sandbox Lifecycle Role

**Status:** Draft — pending your review and sign-off.
**Date:** 2026-10-06
**Deciders:** [your name/title]. Review requested: @PrabhuVijit.
**Related to:** ADR-001 (multitenancy/RLS — this role is the first intentional exception to
"every request resolves to exactly one tenant"), ADR-004 (config-first — unaffected, no module
code involved), `docs/specs/multi-org-sandbox.md` (the spec this ADR unblocks).
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
- Dedicated `/platform-admin` login route, separate dashboard, required TOTP MFA.
- Powers limited to: create / list / read-metadata / reset / delete sandboxes. Never business
  data (tickets, org chart contents, audit entries).
- `tenants.is_sandbox` flags sandboxes for internal tooling.
- Full detail: `docs/specs/multi-org-sandbox.md` §R1-R2.

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
prevents a bug in a platform-admin route's own code (e.g. a future route added by someone
unfamiliar with this constraint, calling the wrong query helper) from accidentally reading
business data anyway. A GRANT-level restriction fails with a hard database permission error in
that case, regardless of what the route code intended. An RLS-policy-condition approach would
instead depend on every table's policy correctly excluding platform-admin by omission — safe by
default today, but more fragile over time as new tables get added by copying existing policies
as templates.

**Cost accepted:** this requires provisioning and maintaining a second Postgres role/connection
pool, separate from the app's normal `app_user` role, and every future metadata field exposed to
platform-admin needs its own explicit GRANT (and Decision 3's DTO type) rather than falling out
of the existing tenant-scoped query path for free.

### Decision 2 — Where the role claim is recognized in the auth path

`packages/auth` recognizes `platform_admin` and skips the `lookupTenantIdByOrgId` resolution step
every other role requires. State explicitly: does an un-resolvable `org_id` claim on a
`platform_admin` token error, or is it simply never read for this role?

### Decision 3 — Response-shape containment

Every `platform_admin`-reachable route returns through one shared, narrow response type, never a
direct query passthrough. Confirm or amend.

### Decision 4 — Sign-off that the spec's invariants are sufficient

This ADR's acceptance is also sign-off that `docs/specs/multi-org-sandbox.md` §V's invariants,
plus the Decision 1 mechanism above, are sufficient for `/security-review` to verify against
concretely.

---

## Consequences

**Enables:** Phase 1 of `docs/specs/multi-org-sandbox.md` can start.

**Risk if mechanism is under-specified:** this is the single highest-risk element of the whole
feature — the one piece of code allowed to deliberately cross the tenant-isolation boundary every
other ADR in this repo treats as absolute. Get this concrete enough that `/security-review` can
check against it line-by-line.

**Follow-up:** once accepted, `/spec-tasks` runs for real against `docs/specs/multi-org-sandbox.md`.

---

## Alternatives considered

| alternative                                                                           | rejected because                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Give `platform_admin` the normal `admin` role plus a special tenant_id sentinel value | Still fundamentally tenant-scoped machinery bent sideways; every RLS policy and route would need to special-case the sentinel                           |
| A separate microservice/admin tool outside the main API                               | Doubles the auth surface, duplicates the Zitadel integration, complicates "works identically local + server"                                            |
| Let `platform_admin` read business data too, just log it heavily                      | R2's limitation to lifecycle-only metadata was a deliberate scope cut to keep blast radius small; logging a bigger power is weaker than not granting it |
