\# ADR-022: Platform Admin — Cross-Tenant Sandbox Lifecycle Role

\*\*Status:\*\* Draft — pending your review and sign-off.

\*\*Date:\*\* 2026-10-06

\*\*Deciders:\*\* \[your name/title]. Review requested: @PrabhuVijit.

\*\*Related to:\*\* ADR-001 (multitenancy/RLS — this role is the first intentional exception to

"every request resolves to exactly one tenant"), ADR-004 (config-first — unaffected, no module

code involved), `docs/specs/multi-org-sandbox.md` (the spec this ADR unblocks).

\*\*Supersedes:\*\* —

\*\*Superseded by:\*\* —

\---

\## Context

\### Problem — sandbox provisioning needs a role no customer tenant should ever have

The Multi-Org Sandbox System (spec: `docs/specs/multi-org-sandbox.md`) lets an internal operator

spin up, reset and delete on-demand trial organizations for prospects. Every existing role in

OpenWind (`admin`, `agent`, `user`) is tenant-scoped: a token carries (or resolves to) exactly one

`tenant\_id`, and every query, RLS policy and route assumes that. This feature needs an operator

who can act \*across\* tenants — create a new one, read lifecycle metadata about several, delete

one — without ever being scoped to any single tenant's business data.

No such role exists today. This is new architectural surface, not a variation on an existing

pattern, which is why CLAUDE.md requires a dedicated ADR before any code lands.

\### What's already decided (not open for re-litigation here)

Settled across three `/interview-me` rounds and an external review from @PrabhuVijit:

\- Platform admin is issued by Zitadel as a role claim, same OIDC mechanism as every other role.

\- Dedicated `/platform-admin` login route, separate dashboard, required TOTP MFA.

\- Powers limited to: create / list / read-metadata / reset / delete sandboxes. Never business

&#x20; data (tickets, org chart contents, audit entries).

\- `tenants.is\_sandbox` flags sandboxes for internal tooling.

\- Full detail: `docs/specs/multi-org-sandbox.md` §R1-R2.

\### What THIS ADR must actually decide

How does a `platform\_admin` request reach Postgres and read/write across tenants, given RLS is

enforced via `SET LOCAL ROLE app\_user` plus a tenant-scoped GUC (`packages/db/src/client.ts`)?

\*\*Option A — `withPlatformContext()`, a second context-setting function alongside

`withTenantContext()`.\*\* Sets a distinct Postgres role (or sentinel GUC value) that every RLS

policy's `USING` clause explicitly checks for, in addition to the existing tenant-match check —

scoped narrowly per-table to only the tables `platform\_admin` routes actually touch.

\*\*Option B — `platform\_admin` routes use a separate, unprivileged connection role with

column-level (not row-level) grants on exactly the metadata columns allowed, with no SELECT grant

on any business-data table at all.\*\* No new RLS policy logic; the guarantee comes from Postgres

GRANT, not a policy condition.

\*\*Recommendation (not binding):\*\* Option B is structurally stronger here, because the entire risk

model is "platform_admin must never be \*able\* to read business data" — a GRANT-level restriction

fails closed, where an RLS-policy-condition fails open if a future table's policy is written

without the same OR-clause. Tradeoff: Option B needs a new Postgres role and careful grant

management per migration.

\---

\## Decision

\### Decision 1 — RLS / cross-tenant write mechanism

\[Option A, Option B, or a third approach — state it, and why.]

\### Decision 2 — Where the role claim is recognized in the auth path

`packages/auth` recognizes `platform\_admin` and skips the `lookupTenantIdByOrgId` resolution step

every other role requires. State explicitly: does an un-resolvable `org\_id` claim on a

`platform\_admin` token error, or is it simply never read for this role?

\### Decision 3 — Response-shape containment

Every `platform\_admin`-reachable route returns through one shared, narrow response type, never a

direct query passthrough. Confirm or amend.

\### Decision 4 — Sign-off that the spec's invariants are sufficient

This ADR's acceptance is also sign-off that `docs/specs/multi-org-sandbox.md` §V's invariants,

plus whichever mechanism is chosen in Decision 1, are sufficient for `/security-review` to verify

against concretely.

\---

\## Consequences

\*\*Enables:\*\* Phase 1 of `docs/specs/multi-org-sandbox.md` can start.

\*\*Risk if mechanism is under-specified:\*\* this is the single highest-risk element of the whole

feature — the one piece of code allowed to deliberately cross the tenant-isolation boundary every

other ADR in this repo treats as absolute. Get this concrete enough that `/security-review` can

check against it line-by-line.

\*\*Follow-up:\*\* once accepted, `/spec-tasks` runs for real against `docs/specs/multi-org-sandbox.md`.

\---

\## Alternatives considered

| alternative | rejected because |

| --- | --- |

| Give `platform\_admin` the normal `admin` role plus a special tenant_id sentinel value | Still fundamentally tenant-scoped machinery bent sideways; every RLS policy and route would need to special-case the sentinel |

| A separate microservice/admin tool outside the main API | Doubles the auth surface, duplicates the Zitadel integration, complicates "works identically local + server" |

| Let `platform\_admin` read business data too, just log it heavily | R2's limitation to lifecycle-only metadata was a deliberate scope cut to keep blast radius small; logging a bigger power is weaker than not granting it |
