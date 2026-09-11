## 2026-09-09 — MIS reporting dashboards (Apache Superset): spec + design

**Session type:** Feature planning — spec documents (no implementation approved yet)
**Branch:** `feat/PLAT-106-superset-dashboard`

### Context

Reporting was the last unbuilt part of track 2D. It was specified for Metabase, deferred, and
sat open as #102–#106. On 2026-08-19 the BI engine was switched to Apache Superset (Metabase's
free tier does static embeds only; per-tenant filtered interactive embedding is a paid feature).
The Metabase-era spec text was never rewritten, so this session produced the specs that replace it.

Product direction settled during the session: **two stages.** Stage 1 embeds fixed dashboards
inside admin-ui and no user ever reaches Superset. Stage 2 exposes Superset on its own URL with
Zitadel SSO, for analysts who need to write their own queries. Stage 2 is additive and staged
after, because query-writing needs a stronger data boundary than viewing does.

### What was produced

**`docs/specs/superset-embedded-dashboarding.md`** — Stage 1. §G/§D/§P/§C/§I/§R/§S/§V/§T/§B.
Defines the views (two tabs, tile-by-tile, every empty/failure state), the request flow, and
23 tasks across three phases. Includes the STRIDE threat model `security.md` mandates.

**`docs/specs/superset-standalone-with-zitadel.md`** — Stage 2. Zitadel OIDC into Superset, claim→role
and org→tenant mapping (reusing the existing `lookupTenantIdByOrgId`), and its own threat model.
Blocked on Stage 1's isolation ADR.

### Decisions recorded

| #   | decision                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Apache Superset over Metabase (2026-08-19, #106)                                                                                                                                                 |
| D2  | embedded first, standalone second                                                                                                                                                                |
| D3  | deployment configures Superset via env vars; tenants only switch it on → **one instance per deployment**, tenants separated by the per-request row filter. No user-entered credentials, no vault |
| D4  | reporting reaches every role, but tabs are gated: Tenant Overview is admin/agent, My Performance is everyone including customers                                                                 |
| D5  | fixed dashboards in Stage 1 — no chart authoring, no user-written SQL                                                                                                                            |

Also decided: live database read-only with no replica (revisited in Stage 2); 60s pass lifetime,
chosen so revocation is prompt; per-user scope uses assigned **or** created only — narrower than
the platform's full "my work" definition, by design ("or granted" removed: `__accessUsers` lives
in `fields` JSONB, which §C forbids any tile from reading).

### Findings that changed the design

All verified against the live stack, not inferred:

- **`analytics_user` has `rolbypassrls = true`.** Superset reads through that role, so Postgres RLS
  contributes nothing and tenant isolation rests on a single layer — the filter we attach per
  request. `security.md` rule 1 mandates two. Three options documented; tenant-scoped views on a
  non-bypass role recommended. **This needs an ADR and has no owner — it gates all implementation.**
- **Grant drift:** `analytics_user` holds SELECT on 34 tables including the raw `workflow_events`
  that migration `0009` deliberately excludes for PII. Pre-existing, unrelated to this work.
- **Superset binds `0.0.0.0:8088`** while every other sensitive service binds `127.0.0.1`
  deliberately (issue #455), and its admin password defaults to `admin` with SQL Lab enabled.
- **`workflow_states.sla_hours` is NULL on every row**, so the three SLA tiles cannot be built.
  Recommendation: ship overdue-by-`due_date` now, hold SLA tiles behind a "configure SLAs" state
  rather than seeding invented targets.
- **Superset's row filters attach per table**; a table no rule matches is returned unfiltered. So
  every dataset on a dashboard must be covered by a filter or the request must be refused.
- **Superset holds two identifiers per dashboard** — its own and a separate embedded id. Only the
  embedded id passes the access check, though the mint endpoint accepts either.
- Only 3 entity instances and 9 workflow events exist, and 3 of 4 workflows have no states, so no
  tile can be visually validated until demo data is seeded.

### Roadmap

New **3G** row added for reporting dashboards (3F was already claimed by the Temporal Scheduler
track, merged after this session started — caught while rebasing onto latest `main`); the 2D row
now records that reporting moved out of it. 3G is 0% and blocked on the isolation ADR.

### Next

Spec review by the repo owner. No implementation until the specs are approved and the isolation
ADR has an owner and a date. Stage 2 goes up as a separate PR later.
