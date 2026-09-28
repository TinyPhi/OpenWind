# ADR-019: Reporting Tenant Isolation — Superset over Platform RLS

**Status:** Draft for peer review (drafted 2026-09-28 from shipped code; ratifies Stages 1–2 merged 2026-09-25).  
**Date:** 2026-09-28.  
**Deciders:** Engineering Lead (acceptance pending). Isolation approach owner: Bikash (decided 2026-09-09).  
**Related to:** ADR-001 (multitenancy, RLS, `analytics_user` grant policy), ADR-007 (RLS on
workflow config tables), ADR-015 (audit/observability, retention and erasure), issue #106 (3G
tracker), #695 (this ADR), PRs #663–#671.  
**Supersedes:** —  
**Superseded by:** —

---

## Context

### Problem — a shared reporting connection that bypassed RLS

Track 3G embeds Apache Superset dashboards in admin-ui (Stage 1) and offers standalone Superset
with Zitadel login and SQL Lab (Stage 2). One Superset instance serves every tenant in a
deployment (`docs/specs/superset-embedded-dashboarding.md` §D3).

Before 3G, the reporting credential `analytics_user` held `BYPASSRLS`
(`docker/postgres/init/001_setup.sql`; spec §P1 shows `rolbypassrls -> t`). Tenant separation
for Superset would then rest on one layer, the row filter attached to each guest token, and
Superset's filter rules are per-dataset (`get_rls_filters`), so a dataset with no rule returns
every tenant's rows (spec §P1, option C). `.claude/rules/security.md` rule 1 requires two layers.

The role could also read 34 tables, 7 without RLS, including `tenants`, `pg_stat_statements` and
`platform_settings` (migration `0113` header). Stage 2 makes this load-bearing. An analyst who
writes SQL can reach every table and column the role can read, so any control that lives in a
view or in a Superset-side filter can be skipped by querying the base table.

### What already exists that this ADR builds on

- Platform RLS keyed on a per-connection GUC:
  `tenant_id = current_setting('app.tenant_id', true)::uuid`
  (`packages/db/migrations/0001_rls_and_tenancy.sql`, lines 86–103). With `missing_ok = true`, an
  unset GUC reads as NULL and the policy evaluates false.
- ADR-001's default-deny, column-level grant discipline for `analytics_user` (migration `0009`).
- The append-only `admin_audit_log` with a closed `action` vocabulary (`packages/audit`).
- Zitadel org → tenant mapping (`tenants.zitadel_org_id`).

---

## Decision

### Decision 1 — Stamp `app.tenant_id` per connection with `DB_CONNECTION_MUTATOR`; reuse existing RLS

Superset's `DB_CONNECTION_MUTATOR` hook (`docker/superset/superset_config.py`, "Tenant isolation"
block) adds `-c app.tenant_id=<uuid>` to the libpq `options` of each reporting connection. The
existing RLS policies then apply to Superset as they do to the API. This is option A of spec §P1,
resolved 2026-09-09. We rejected per-tenant credentials (option B: N credentials to provision and
rotate) and Superset-only filters (option C: fails open).

The mutator resolves the tenant in order, and each source must match a strict UUID regex
(`_TENANT_ID_RE`):

1. the connection's effective username, which for an embedded request is the guest token's
   `user.username`. The API sets this to the tenant id (`mintGuestToken` in
   `apps/api/src/routes/reporting/superset-client.ts`);
2. the signed guest token on the request, for dashboard-level queries that Superset runs as the
   dashboard owner, such as native-filter option lists (`_tenant_from_guest_token`);
3. the logged-in Stage 2 user's `tenant:<uuid>` role (`_tenant_from_user_roles`, which refuses a
   user who holds more than one).

If no source yields a valid UUID, the GUC is left unset and every policy returns zero rows. The
failure mode is an empty dashboard, not another tenant's data. The regex is also the defence
against option injection into the connection string. The comments say two properties of the
pinned image were verified against its source: `get_sqla_engine_with_context()` defaults to
`NullPool`, so no stamped connection is reused across callers, and the identity is available
without `impersonate_user`. The image is `openwind-superset:6.1.0`, and the re-pin note in
`docker-compose.yml` says the hook is unchanged between 6.0.x and 6.1.0.

Two conditions are required for this to work, and they shipped together in migration `0112`.
First, `analytics_user` becomes `NOBYPASSRLS`. Second, `workflow_events_masked` gets
`security_invoker = true`. Without the second, a view runs as its owner (`migration_user`, which
has `BYPASSRLS`). The migration records a measurement where the base table returned 0 rows to a
non-owning tenant and the view returned all 48.

### Decision 2 — `analytics_user` is least-privilege by table and by column

The reporting credential is the existing `analytics_user`, created by
`docker/postgres/init/001_setup.sql`. It is not a new role. Every migration statement that names
it is guarded on `pg_roles`, following the `0009` convention.

| Migration | Effect                                                                                                                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0112`    | `NOBYPASSRLS`; `security_invoker` on the masked view; column grant on `workflow_events` without `metadata`                                                                                                                                                                                                           |
| `0113`    | `REVOKE SELECT ON ALL TABLES`, revoke default privileges, then re-grant only `entity_instances`, `workflow_events`, `workflow_events_masked`, `workflows`, `workflow_states`, `tenant_users` and `entity_types`. Also revokes `pg_stat_statements` / `_info` from `PUBLIC`, where the extension grant actually lives |
| `0114`    | `tenant_for_org(text)`: `SECURITY DEFINER`, pinned `search_path`, returns one tenant id or NULL. `EXECUTE` is granted only to `analytics_user`, and `tenants` stays ungranted                                                                                                                                        |
| `0118`    | Removes 0113's table-level grant on `workflow_events`. Re-grants 12 named columns (0112's 11 plus `event_type`). `metadata` and `origin_*` are withheld                                                                                                                                                              |
| `0120`    | `tenant_users`: only `user_id, tenant_id, display_name`. `email`, `id` and `created_at` are withheld                                                                                                                                                                                                                 |
| `0122`    | `entity_instances`: 13 named columns. `fields`, `search_vector` and `origin_*` are withheld                                                                                                                                                                                                                          |
| `0123`    | Adds a column grant on `reporting_priority`                                                                                                                                                                                                                                                                          |
| `0124`    | `reporting_instances` view (`security_invoker = true`) over exactly the granted `entity_instances` columns, with `GRANT SELECT` on the view                                                                                                                                                                          |

**Can read:** tenant-scoped rows of the tables above. These are `workflows`, `workflow_states` and
`entity_types` in full (ADR-001 per-table policy), plus the column allowlists above.

**Cannot read:** `tenants`, `entity_fields`, `workflow_transitions`, automation, outbox, API-key
and credential tables (ADR-001 per-table policy); raw form and event payloads; user email;
`pg_stat_statements`.

**Cannot write:** anything, except through the two definer functions (Decision 6).

The `0124` view exists because Superset applies a guest token's row filter as
`FROM (SELECT * FROM <table> WHERE …)`. `SELECT *` needs a table-level grant, and column grants do
not satisfy it. The migration says this broke 23 of 35 charts after `0122`.

### Decision 3 — Exclude payloads through derived projections, not redaction (ratifies option C's invariant)

OQ-13 was resolved on 2026-09-14 as option C, owner Bikash (spec §P1c, T3c). Option C is "redact
on write into a stored column; the reporting role is never granted raw
`workflow_events.metadata`". The shipped work keeps the invariant but uses a narrower mechanism,
recorded in `docs/specs/reporting-metadata-masking-repair.md` §D (2026-09-21/22). It does not store
a redacted copy of the payload. Instead, trigger-maintained columns mirror the only keys any
dataset reads:

- `workflow_events.event_type` mirrors `metadata->>'type'` (`0117`).
- `entity_instances.reporting_title` and `reporting_department` mirror the matching `fields` keys
  (`0121`), and `reporting_priority` is added in `0123`.

Plain nullable columns with a `BEFORE INSERT OR UPDATE` trigger were chosen over stored generated
columns. A stored generated column rewrites the table under `ACCESS EXCLUSIVE` on PostgreSQL 16.
Backfills are batched in groups of 5,000 and are idempotent. `workflow_events_masked` is dropped
(`0119`), because under invoker semantics it could only be read by a role that already held the
column it hid. ADR-001 was amended on 2026-09-22 to describe exclusion rather than redaction.

The result is that the payload is ungranted on every path. A column added later to a granted table
stays unreadable until someone grants it deliberately.

### Decision 4 — Within-tenant "own rows" is a database policy, not only a token clause

Migration `0116` adds a `RESTRICTIVE` `FOR SELECT TO analytics_user` policy, `reporting_own_rows`,
on `entity_instances` and on `workflow_events` (the latter via `EXISTS` on the parent ticket).
When `app.reporting_scope = 'own'`, rows are limited to
`assigned_to` / `created_by = app.reporting_user_id`. When the scope is absent, the policy
evaluates true, so the tenant clause alone applies. The mutator stamps `own` scope for non-staff
Stage 2 sessions. These are sessions whose Zitadel roles do not intersect
`STAFF_ROLE_KEYS = {admin, agent, superadmin}`. An unusable subject is stamped as `-`, so it
matches nothing rather than falling back to the whole tenant.

### Decision 5 — Stage 1: short-lived guest passes minted by the API, with a second filter layer

`GET /superset/guest-token` (`apps/api/src/routes/reporting/guest-token.ts`, mounted in
`apps/api/src/app.ts`) is gated as follows:

- It requires `requireAuth()` and `requireRole("agent", "admin", "user")`.
- The `tenant` dashboard is staff-only. A non-staff request gets 403 and a
  `reporting.guest_token_denied` audit row.
- The pass carries `username = tenantId` (Decision 1). Its row filters are an unscoped
  `tenant_id = '<uuid>'` clause, plus per-dataset own-rows clauses on the `user` dashboard.
  Ids are allowlist-validated because the clauses are raw SQL fragments.
- `mintDashboardPass(..., requireFullCoverage)` refuses to mint a `user` pass if any dataset on
  the live dashboard has no row filter.
- Pass lifetime is 60 s (`GUEST_TOKEN_JWT_EXP_SECONDS`). The API rejects any minted pass that
  expires more than 90 s out (`MAX_GUEST_TOKEN_LIFETIME_SECONDS`), so the Superset default of
  300 s cannot return silently.
- `reporting.guest_token_issued` and `reporting.guest_token_denied` are written through
  `writeAuditEntry` under `withTenantContext`. Both are registered in
  `packages/audit/src/outcome.ts` and `request-kind.ts`, and they are best-effort: a failed audit
  write is logged and does not fail the request.
- All errors return a flat 502 `REPORTING_UNAVAILABLE`.
- Superset's guest role is `EmbeddedViewer`, not `Public`.

### Decision 6 — Stage 2: standalone Superset + Zitadel SSO + SQL Lab, off by default

The whole `AUTH_OAUTH` block is gated on `SUPERSET_OAUTH_CLIENT_ID`
(`docker/superset/superset_config.py`). SQL Lab exposure on the reporting connection follows the
same variable (`expose_in_sqllab` in `ensure_reporting_database`, `docker/superset/bootstrap.py`),
and `allow_dml`, `allow_ctas` and `allow_cvas` are always false. `close_sqllab_exposure_elsewhere`
turns SQL Lab off on any other registered database. The client is a confidential web app
provisioned by `scripts/setup-superset-oauth.ts`. Its credentials come from `.env.local` through
`env_file` and are deliberately absent from `environment:` (`docker-compose.yml`).

At login, `OpenWindSecurityManager` does the following:

1. It reads `urn:zitadel:iam:user:resourceowner:id` and resolves it through `tenant_for_org()`.
   It does not query `tenants`. The spec pointed to `lookupTenantIdByOrgId` in `packages/auth`,
   but the shipped code uses the SQL function instead.
2. It rebuilds the `tenant:<uuid>` and `owuser:<subject>` roles on every login
   (`AUTH_ROLES_SYNC_AT_LOGIN`).
3. It leaves a login with no tenant bound to no tenant, so that session sees nothing.

`PERMANENT_SESSION_LIFETIME` defaults to 480 minutes (`SUPERSET_SESSION_MAX_MINUTES`).

SQL Lab queries (`sql_json`, `sqllab_viz`) and CSV exports are appended to `admin_audit_log` by
`PlatformAuditEventLogger` through `record_reporting_audit()` (`0115`). That function is
`SECURITY DEFINER`, accepts only the two reporting actions, and requires the stated tenant to match
the session's `app.tenant_id`. The append is best-effort: a failure is logged and the query still
runs.

**Stage 2 must not be enabled on any deployment until the pending security review noted under
Consequences closes.** Stage 2 is why Decisions 1–4 must be database-enforced. Ad-hoc SQL passes through no guest token,
no dataset filter and no view the user cannot avoid. What is left is RLS keyed on the stamped GUC,
the restrictive own-rows policy and the grant allowlist.

### Decision 7 — Deployment shape

- Superset and `superset-init` run under compose profile `reporting` (`docker-compose.yml`), which
  `.env.example` enables by default (`COMPOSE_PROFILES=reporting`).
- The port is bound to loopback only.
- Memory is capped at 2g.
- Superset's own metadata lives in a separate `superset` database as `superset_user`.
- The reporting connection is `analytics_user@postgres:5432/platform`. It goes **directly to
  Postgres, not through PgBouncer**, and stays that way. PgBouncer is configured for the single
  user `app_user` (`docker-compose.yml` comment on `DATABASE_URL`). It also cannot carry the
  Decision 1 stamp: the pinned `edoburu/pgbouncer` digest runs PgBouncer 1.25.2 with the image
  default `ignore_startup_parameters = extra_float_digits` and no `track_extra_parameters`, and
  a client that sends `options=-c app.tenant_id=<uuid>` is refused at login with
  `FATAL: unsupported startup parameter in options: app.tenant_id` (checked against that digest
  on 2026-09-28; a control connection without `options` passed the startup check). Routing
  reporting through it therefore fails loudly rather than leaking. Listing the parameter in
  `ignore_startup_parameters` would, per PgBouncer's documented behaviour, drop it silently, so
  every reporting query would return zero rows. Neither is a fix, so reporting connections are not routed through PgBouncer.
- `@platform/config` refuses to start in production with dev-default or short
  (< 32 chars) `SUPERSET_SECRET_KEY` and `SUPERSET_GUEST_TOKEN_SECRET`, with dev-default service
  account or admin passwords, or with identical `SUPERSET_SITE_URL` and `SUPERSET_INTERNAL_URL`
  (`packages/config/src/env.ts`).

---

## Consequences

### Positive

- There is one isolation mechanism for API and reporting: the same RLS policies and the same GUC,
  with no per-tenant views or credentials to keep in sync.
- It fails closed. A missing or malformed identity stamps nothing, and the result is zero rows,
  not an error that confirms existence (`apps/api/tests/isolation/reporting-grants.isolation.test.ts`,
  "returns nothing on a connection with no tenant stamped").
- There are two independent layers on Stage 1: database RLS and guest-token filters, plus a
  full-coverage check at mint time.
- Payload exclusion is structural. New columns are unreadable by default, and the isolation test
  suite pins "no table-level grant on any table carrying a payload".
- Reporting access and SQL Lab and export activity land in the platform's own audit store rather
  than only in Superset's editable log.

### Negative and mitigations

- **Stage 2 is pending a security review.** Ad-hoc SQL (Decision 6) makes the database-side
  controls the only boundary, and a review of how they hold up against a SQL Lab session is
  open and tracked privately. **Mitigation: Stage 2 must stay disabled (`SUPERSET_OAUTH_CLIENT_ID`
  unset) on every deployment until that review closes and this ADR records the outcome.**
- **Reporting connections bypass PgBouncer.** Under `NullPool`, each query opens a new physical
  Postgres connection. The spec's 200-concurrent target (§P, capacity, and T17) therefore lands on
  Postgres `max_connections`. Spec §P said to route through `ow-pgbouncer`, but the shipped code
  does not, and should not: the pinned PgBouncer refuses the startup parameter that carries the
  tenant (Decision 7). Mitigation: tracked on T17, and the compose comment states it. Postgres
  runs with `max_connections=200` (`docker-compose.yml`), shared with `ow-pgbouncer`'s pool
  (`DEFAULT_POOL_SIZE: 20`) and direct `migration_user` connections, so T17's load test must
  measure reporting against that ceiling. Supporting pooled reporting would need a different
  tenant carrier, which is a new decision for this ADR, not a PgBouncer setting.
- **Owner bypass.** Base tables are owned by `migration_user` (`BYPASSRLS`), and no reporting table
  uses `FORCE ROW LEVEL SECURITY`. Any view over these tables that lacks `security_invoker = true`
  silently removes tenant isolation (`0112`, `0124` comments). Mitigation: an isolation test
  asserts `security_invoker` on `reporting_instances`, and `0124`'s `COMMENT ON VIEW` warns about
  it. Any future reporting view needs the same test.
- **Bootstrap ordering.** `001_setup.sql` still creates `analytics_user` with `BYPASSRLS` and a
  default `SELECT` privilege (lines 76–77 and 85), which `0112` and `0113` then remove. The file
  contradicts itself: its line 31 comment says "BYPASSRLS was removed by migration 0112", but
  line 85 still grants it. `superset-init` depends only on Postgres being healthy. Migrations run
  in the separate `bootstrap` profile (`docker compose --profile bootstrap run --rm bootstrap`),
  which `up` never starts, so a compose `depends_on` cannot order the two. Mitigation: none
  beyond running migrations before first use; see OQ-4.
- **Mutator failure.** A missing identity fails closed (above). The repo has no automated test of
  the Python mutator itself: none was found under `docker/superset/`, and the isolation tests set
  the GUCs directly. Behaviour when the mutator raises an exception is not verified.
- **Audit is fail-open.** Both the guest-token and SQL Lab audit writes are best-effort. The Stage 2
  actor is the Zitadel login name, not always the subject id (standalone spec T11). This is
  recorded as a compliance-owner decision in the `superset_config.py` comments.
- **Revocation windows.** A role downgrade inside a valid JWT is not re-checked when a pass is
  minted, and it is bounded only by the 60 s pass (`guest-token.ts` comment). Stage 2 sessions
  last up to 480 minutes, with no Zitadel single-logout (T9 partial) and no MFA (T10).
- **Free-text `comment` remains granted** on `workflow_events` (masking-repair spec §D, OQ-1). PII
  typed into comments is readable by reporting within scope.
- **Projection drift is a boundary.** A new chart needing another payload key requires a new
  trigger column and a new grant. Mitigation: one trigger function covers all `entity_instances`
  projections (`0123`), and a drift test exists ("derived reporting columns cannot drift").

---

## Deferred Decisions

| Deferred item                                             | Trigger to revisit                              | Why deferred                                                                        |
| --------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Export limits distinct from query limits (Stage 2 T12)    | Before Stage 2 serves a real deployment         | Export is ungranted pending T12 (standalone spec status note)                       |
| MFA for the analyst role; Zitadel single-logout (T9, T10) | Before Stage 2 serves a real deployment         | No per-role step-up or SLO mechanism exists in the platform                         |
| PgBouncer support for the reporting role (T17)            | Load test against the 200-concurrent target     | `app_user` only; pinned PgBouncer refuses the tenant startup parameter (Decision 7) |
| Per-user "granted access" leg (`__accessUsers`)           | Payload projection for access lists is designed | That list lives in `fields`, which is withheld (`guest-token.ts`)                   |
| Refusing queries when the audit store is unreachable      | Compliance owner requires fail-closed audit     | Fail-open chosen to avoid breaking dashboards on audit hiccups                      |

---

## Open Questions

| ID   | Question                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Stage 2 security review (session-level controls, and Stage 2 cache tenancy).                                                                  | Tracked privately; Stage 2 stays disabled until it closes. Outcome to be recorded here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OQ-4 | Should `001_setup.sql` stop granting `BYPASSRLS` and default `SELECT` to `analytics_user`, instead of relying on `0112`/`0113` to undo them?  | **Proposed:** yes. Create the role with neither: delete `ALTER USER analytics_user BYPASSRLS` (line 85) and the `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES TO analytics_user` block (lines 76–77), keeping `CONNECT` and schema `USAGE`. Keep `0112`/`0113` as they are, since existing volumes never re-run init scripts. Because migrations run in a separate profile, do not add a compose `depends_on`; have `superset-init` refuse to register the reporting connection if `reporting_instances` (`0124`) is absent. Why: it is defence in depth, it closes the window between init and migrations, and it fixes the file's self-contradicting comment (Consequences). Needs human confirmation. |
| OQ-5 | Is shipping exclusion via projections, instead of option C's stored redacted copy, accepted as the implementation of the 2026-09-14 decision? | **Proposed:** accept projections as satisfying option C. Option C's invariant is that the reporting role is never granted raw `workflow_events.metadata`. Projections meet it and go further, because the role can read no raw payload column on any table (`metadata` and `fields` both withheld, Decision 3). A stored redacted copy would still expose whatever the redactor missed. Needs confirmation from the option C owner (Bikash), recorded here or in the masking-repair spec.                                                                                                                                                                                                                     |

---

## Implementation status

- **Merged (2026-09-25, PRs #663–#671)** per `docs/tracker/roadmap-tracker.md` (3G row):
  migrations `0112`–`0124`, the `superset_config.py` mutator and SSO, the `bootstrap.py`
  provisioning, `GET /superset/guest-token`, the `@platform/config` guards, the audit actions and
  the admin-ui reporting page.
- **Tests:** `apps/api/tests/isolation/reporting-grants.isolation.test.ts` (grants, view invoker
  semantics, tenant and own-rows scoping, projection drift, `record_reporting_audit` tenant
  binding); `apps/api/tests/isolation/reporting-guest-token.isolation.test.ts`;
  `apps/api/src/routes/reporting/*.test.ts`; `packages/config/src/env.test.ts`.
- **Open before Stage 2 production use:** OQ-1, T9, T10, T12, T17.
- **ADR-001 amended alongside this draft (#695):** its role table now lists `analytics_user` as
  "Column-scoped SELECT, subject to RLS | Superset reporting (see ADR-019)", and its Negative
  consequences no longer name `analytics_user` as a cross-tenant bulk-operation path.
- **On acceptance:** add ADR-019 to the CLAUDE.md "Read before touching" table for
  `docker/superset/` and reporting migrations.
