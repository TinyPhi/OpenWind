# Reporting — Embedded Dashboards (Stage 1)

> MIS reporting inside admin-ui: two per-tenant dashboards rendered from Apache Superset, row-filtered server-side. Users never reach Superset. Stage 2 (standalone Superset + Zitadel login) is `superset-standalone-with-zitadel.md`.

status: draft
created: 2026-09-09
updated: 2026-09-09
issue: #106 (tracker) · #102 #103 #104 #105 (tasks)

---

## §G Goal

A user opens **Reporting** in admin-ui and sees charts answering "how is work going?" — open
volume, what is late, where things get stuck, who is loaded — scoped to what that user is allowed
to see.

We are not building charting. We deploy Apache Superset, point it at platform data, and embed its
dashboards. OpenWind owns identity, tenancy and the page; Superset owns rendering.

| stage                         | delivery                                                          | audience                     |
| ----------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| **1 — embedded** _(this doc)_ | fixed dashboards inside admin-ui, no Superset login               | everyone, scoped per role    |
| 2 — standalone                | Superset's own site, Zitadel login, users write their own queries | analysts who need to explore |

done looks like:

- a user opens Reporting and sees populated charts containing their tenant's data and no other's
- the per-user tab narrows to work they are involved in
- Superset unavailable → a readable message on that page only

## §D Decisions

**D1 — Apache Superset.** Metabase's free tier does static embeds only; per-tenant filtered
interactive embedding is a paid feature. Superset covers it in the OSS tier, consistent with the
self-hosted stack (decided 2026-08-19, issue #106).

**D2 — embedded first, standalone second.** Stage 1 gives everyone fixed dashboards with no new
attack surface. Stage 2 opens query-writing and needs a stronger data boundary, so it is staged
after. Embedded matches `architecture-brief.md` §8.11 and `platform-vision.md` ("no direct DB
access from UI").

**D3 — deployment configures Superset; reporting is always-on for every tenant** (updated
2026-09-09 — there is no per-tenant enable/disable switch, R8 removed). Connection details are env
vars via `@platform/config` (`.env.local` locally — note `.env` is tracked in git — and the same
names at deploy time). There is no store for user-entered credentials, so **one Superset instance
per deployment**; tenants are separated by the row filter on each request, not by separate
instances. The Connectors screen (T31) is status-only, never a credentials form and never an
enable/disable toggle.

**D4 — every role gets reporting, but the tabs differ by role** (decided 2026-09-09).

| role          | Tenant Overview | My Performance                     |
| ------------- | --------------- | ---------------------------------- |
| admin / agent | yes             | yes                                |
| customer      | **no**          | yes — records they are involved in |

Not admin-only, which is the departure from how the rest of the admin-ui gates analytics. But
tenant-wide figures are agent-and-above only: a customer has no business seeing another
customer's volumes, so they get a single-tab page. The tab strip is not rendered for them.

**D5 — fixed dashboards, not a builder.** Stage 1 ships a defined tile set. No chart authoring, no
user-written SQL, no dashboard picker. Those are Stage 2.

## §P Challenges

Each has options and a recommendation. Evidence is a command or `file:line`.

### P1 — the reporting database role can read every tenant _(must be settled first)_

```
$ psql -c "SELECT rolbypassrls FROM pg_roles WHERE rolname='analytics_user'"   -> t
```

That role skips Postgres row-level security. If Superset reads through it, tenant separation rests
on **one** thing: the filter we attach per request. `.claude/rules/security.md` rule 1 mandates two
independent layers.

| #   | option                                                                                                                                                                  | fails closed?                                                                                                                    | cost                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A   | Superset reads the **real base tables**, via `DB_CONNECTION_MUTATOR` stamping `app.tenant_id` per connection, under a role with no `BYPASSRLS`, relying on existing RLS | yes — an unscoped connection returns nothing, RLS-enforced at the database                                                       | one Superset config file addition     |
| B   | per-tenant database credential; ordinary RLS applies                                                                                                                    | yes                                                                                                                              | N credentials to provision and rotate |
| C   | keep the current role, rely on Superset's own filter rules                                                                                                              | **no** — Superset attaches rules per table (`get_rls_filters`), so a table nobody attached a rule to returns every tenant's rows | lowest                                |

**Recommend A, resolved 2026-09-09.** Superset exposes a config hook, `DB_CONNECTION_MUTATOR`
(confirmed present in the running container's `superset/models/core.py`, invoked inside
`_get_sqla_engine()` right before `create_engine()` is called). It receives `effective_username`,
which is derived from `get_username()` → `g.user.username` — i.e. whatever we put in the guest
token's `user.username` field when we mint it, something `superset-client.ts`/`guest-token.ts`
already fully control. The mutator uses that identity to inject
`connect_args={"options": "-c app.tenant_id=<tenantId>"}` per connection, stamping the platform's
existing GUC — the exact mechanism `withTenantContext`/RLS elsewhere in this platform already
relies on. Once stamped, Superset reads the REAL base tables directly under the EXISTING RLS
policies from migration `0001_rls_and_tenancy.sql`. **No new views need to be invented** — this
replaces Option A's original "tenant-scoped views on a non-`BYPASSRLS` role" outright.

Two safety properties, both verified live against the running container's source:

1. **No connection-pool leak risk.** `get_sqla_engine_with_context()` is a `@contextmanager` called
   fresh per query, with `nullpool: bool = True` as the default parameter — meaning `NullPool` is
   used, so a brand-new physical connection is opened and closed per query. No connection is ever
   reused across different guest identities/tenants.
2. **Does not require `impersonate_user`.** `get_effective_user()` checks `get_username()` (i.e.
   `g.user.username`, set unconditionally whenever a guest-token request has a `g.user`) before
   ever consulting `impersonate_user`, so the identity is already available with zero extra config.

C is the trap: the boundary would be a config row and the database would not catch the error.

### P1b — a masked view bypasses tenant isolation, silently defeating P1's fix

Found independently while verifying the P1 fix above, not part of the original review.
Live-tested against the actual `ow-database` container, in a rolled-back transaction, nothing
persisted: created a role with `NOBYPASSRLS`, set `app.tenant_id` to a tenant not in the data, then
queried:

- directly from `workflow_events` (the base table, RLS policies `tenant_read`/`tenant_write` using
  `current_setting('app.tenant_id', true)::uuid`): **0 rows returned — correct, RLS enforced.**
- through `workflow_events_masked` (the existing masked view from migration
  `0009_analytics_user_grants.sql`, owned by `migration_user`): **48 rows returned — wrong, RLS was
  silently bypassed.**

Root cause: PostgreSQL views run with the view **owner's** privileges by default (`security_invoker`
defaults to false pre-PG15 semantics unless explicitly set), not the querying role's privileges, so
RLS on the underlying base table does not apply when queried through the view — this would have
silently defeated the P1 fix above for any tile reading a view instead of a base table.

Verified fix: `ALTER VIEW workflow_events_masked SET (security_invoker = true);` — re-tested and
querying as the wrong tenant now correctly returns 0 rows, querying as the correct tenant still
correctly returns all 48 rows.

**`workflow_events_masked` (and any other view used for reporting reads) MUST have
`security_invoker = true` set.** This is its own required migration, done in the SAME migration as
re-asserting the P2 grant allowlist (T3) — once `security_invoker` is on, the querying role needs
its own read grant on the underlying base table's columns; it can no longer borrow the view
owner's implicit access. See §V.

**A related, now mostly-moot concern: a chart query using a CTE could read a view before any
filter applies.** Under the original "views + a filter pasted onto the outer query" design, a
Superset chart written as `WITH base AS (SELECT * FROM some_view) SELECT * FROM base WHERE ...`
could pull unfiltered rows into `base` before the outer filter ever runs. Under the P1/P1b design
above, this mostly dissolves — isolation now sits on the base table via `app.tenant_id` and RLS,
not on a filter glued to the outside of the query, so an inner CTE step is scoped the same as an
outer one. Kept as a light provisioning check anyway: audit chart SQL for CTE patterns during T12's
provisioning before enabling a dashboard, since it costs little and this is exactly the kind of
thing that is cheap to check and expensive to discover later.

### P2 — the reporting grant is wider than policy

```
$ psql -c "SELECT count(*) FROM information_schema.table_privileges
           WHERE grantee='analytics_user' AND privilege_type='SELECT'"   -> 34
$ psql -c "SELECT has_table_privilege('analytics_user','workflow_events','SELECT')"  -> t
```

Migration `0009_analytics_user_grants.sql:89-91` deliberately **excludes** raw `workflow_events`
("metadata JSONB may contain PII") in favour of `workflow_events_masked`. The live grant includes
it. Pre-existing drift.

**Recommend:** re-assert the allowlist in a migration, and add a test pinning the exact granted
table set so drift is caught rather than discovered.

### P3 — Superset is network-reachable with a default password

```
$ docker port ow-superset      ->  8088/tcp -> 0.0.0.0:8088
```

Every other sensitive service binds `127.0.0.1` deliberately (see the compose comments citing
issue #455). Superset is the exception, and has an admin account defaulting to `admin`
(`docker/superset/init.sh:13`) with SQL Lab enabled on the P1 connection.

**Recommend:** loopback bind, mandatory admin password, SQL Lab off. Hours of work.

Confirmed by direct inspection: every other sensitive service in `docker-compose.yml`
(`postgres`, `pgbouncer`, `openbao`, `redis`) explicitly binds `127.0.0.1:` in its port mapping.
Superset's port line (`docker-compose.yml` line ~499,
`"${SUPERSET_HOST_PORT:-8088}:8088"`) has no such prefix. The fix is a one-line change: prefix
that port mapping with `127.0.0.1:`, matching the other four services exactly. This does not
affect local dev — browser and Docker run on the same machine there, so `localhost` and
`127.0.0.1` are identical — it only closes exposure on a real deployed server.

### P4 — no SLA targets are configured, so SLA tiles cannot be built

```
$ psql -c "SELECT name, sla_hours FROM workflow_states"   -> sla_hours NULL on every row
```

Three of the highest-value tiles need `workflow_states.sla_hours`.

| #   | option                                                          | effect                                         |
| --- | --------------------------------------------------------------- | ---------------------------------------------- |
| A   | ship without SLA tiles; enable them when tenants configure SLAs | honest, smaller v1                             |
| B   | seed default SLA hours in module seeds                          | tiles work immediately, on invented numbers    |
| C   | use `due_date` as an end-to-end target instead                  | works today, answers "late?" not "slow where?" |

**Recommend A + C.** Ship overdue-by-due-date now, and hold SLA tiles behind a "configure SLAs to
enable" state. B invents numbers a manager would act on.

### P5 — there is not enough data to validate a chart

3 entity instances, 9 workflow events, and 3 of 4 workflows have no states configured. A wrong
chart looks fine at this volume.

**Recommend:** seed demo data (a few hundred records spread across states, assignees and dates)
before any tile is signed off. `scripts/seed-demo.ts` is the place.

### P6 — every pass re-authenticates from scratch, so normal traffic is the load problem

Each pass costs three Superset calls including a password hash, and the service-account session is
not reused. With a 60s pass lifetime that repeats per open dashboard indefinitely — so at 200
concurrent dashboards it is ~200 logins per minute from _legitimate_ users, not from an attacker.
The threat model files mint-flood under denial-of-service; the bigger version is self-inflicted.

| #   | option                                                                                                | effect                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A   | cache the service-account session (token + CSRF + cookie) in-process until it expires, refresh on 401 | one login per session lifetime instead of per pass; needs a decision on concurrent access to that shared state |
| B   | no cache, raise the pass lifetime                                                                     | fewer mints, but weakens R9's prompt revocation                                                                |
| C   | no cache, accept the load                                                                             | simplest, and the thing that falls over first under real use                                                   |

**Recommend A**, with a single-flight guard so concurrent requests share one refresh rather than
stampeding, and retry-once-on-401 so a Superset restart or a rotated `SUPERSET_SECRET_KEY` (which
invalidates its sessions and CSRF tokens) recovers instead of failing the page. Capacity must be
stated as a number and load-tested — not left as "it is rate limited".

**Capacity target, decided 2026-09-09: 200 concurrent dashboards per deployment.** Consequence: at
200 concurrent dashboards, Superset will open many short-lived database connections — per P1's
finding that `get_sqla_engine_with_context()` defaults to `nullpool: bool = True`, there is no
connection reuse across queries. Superset's database connection must therefore be routed through
the existing `ow-pgbouncer` connection pooler already in this stack, rather than connecting
directly to Postgres.

### P7 — one Superset instance means one blast radius, wider than the SQL grant

Verified: the Superset container reaches the database directly on the docker network
(`postgres:5432 REACHABLE from superset container`). Loopback-binding the browser port (P3) stops
browsers; it does not reduce what Superset itself can reach. So a Superset compromise is not only
a row-filter problem — it holds a database credential and a network path.

Two further facts widen this beyond what the row filter governs:

- **Query results are cached in Redis** (`CACHE_TYPE: RedisCache`, `DATA_CACHE_CONFIG`), so tenant
  rows exist outside the masked views the grant governs.
- **A known signing key forges an admin session.** This is the mechanism behind
  [CVE-2023-27524](https://www.openwall.com/lists/oss-security/2023/04/24/2) (default `SECRET_KEY`
  → forged session → admin → RCE). That CVE affects Superset ≤ 2.0.1 and **not** our `4.0.2` — but
  the repo currently ships a _working default_ for `SUPERSET_SECRET_KEY`, which recreates the same
  attack on a fully patched version. Removing usable defaults is therefore not hygiene, it is the
  mitigation for a known exploit class.

| #   | option                                                                                        | effect                                                                               |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A   | network-restrict Superset to the tenant-scoped views' host/port only, alongside the SQL grant | defence at two layers; needs network policy the compose setup does not express today |
| B   | accept the blast radius, in writing, and compensate with patch cadence + no default secrets   | cheap, honest, and leaves an RCE holding a DB credential                             |

**Recommend B now, A when this leaves single-node compose** — but the acceptance must be explicit
in this spec, not implied. Either way, digest-pinning without a **re-pin cadence** just freezes
today's CVE exposure, so a tracked upgrade path is part of the mitigation.

**Fact, zero configuration required:** guest tokens are already audience-locked to one Superset
site by default. Superset's `GUEST_TOKEN_JWT_AUDIENCE` config falls back to `get_url_host()`
(confirmed in the running container's `superset/security/manager.py` line 2274) when not
explicitly set, so cross-environment token replay is already not possible today.

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BI engine        | Apache Superset `4.0.2`, digest-pinned like every other third-party image; `superset` and `superset-init` move in lockstep. **Pinning requires a re-pin cadence** — a tracked CVE check against the pinned digest, aligned with how `CLAUDE.md`'s maintenance notes handle npm overrides                                                                                                                  |
| transport        | `SUPERSET_INTERNAL_URL` carries the service-account login, CSRF token and session cookie. Plain HTTP is acceptable **only** while that hop stays inside a single host's docker network; any topology where it crosses a network segment requires TLS                                                                                                                                                      |
| secrets          | no usable defaults, and a written rotation procedure. Rotating `SUPERSET_GUEST_TOKEN_SECRET` invalidates live embeds (acceptable at 60s); rotating `SUPERSET_SECRET_KEY` also invalidates Superset's own sessions, so the mint path must retry once on 401                                                                                                                                                |
| admin account    | the Superset admin password is mandatory, generated not chosen, and stored the same way every other platform credential is — never in the image, never a default                                                                                                                                                                                                                                          |
| data at rest     | Superset caches query results in Redis and may write exports/thumbnails to its own volume, so **tenant data exists outside the masked views**; both are in scope for retention and erasure questions                                                                                                                                                                                                      |
| backup           | Superset's metadata database holds every dashboard, chart, user and role. `scripts/backup.sh` dumps only the `platform` database today, so it must be extended — the YAML export covers dashboards but not users or roles                                                                                                                                                                                 |
| frame protection | admin-ui sends `Content-Security-Policy: frame-ancestors 'self'`; the embed iframe keeps the sdk's sandbox no wider than the handshake needs                                                                                                                                                                                                                                                              |
| embedding        | `@superset-ui/embedded-sdk` — the sdk owns the iframe and its handshake; never a hand-rolled `<iframe src>`                                                                                                                                                                                                                                                                                               |
| auth (users)     | Zitadel only; no user-facing Superset auth of any kind                                                                                                                                                                                                                                                                                                                                                    |
| auth (machine)   | one least-privilege Superset service account, backend-only, able to mint embed passes and nothing else — the exact permission is `can_grant_guest_token` (confirmed present in the running container's `superset/security/manager.py` line 259, used via `@permission_name("grant_guest_token")` in `superset/security/api.py` line 117)                                                                  |
| config           | env vars via `@platform/config`; no secrets in the database, none user-entered                                                                                                                                                                                                                                                                                                                            |
| tenancy          | row filter attached server-side at request time; never a client param, never UI-only                                                                                                                                                                                                                                                                                                                      |
| DB access        | live database, read-only, **no replica** — acceptable in Stage 1 because users cannot write queries; Stage 2 revisits it                                                                                                                                                                                                                                                                                  |
| data surface     | only tables the reporting role is granted; masked views per ADR-001; **no tile reads `fields` JSONB**                                                                                                                                                                                                                                                                                                     |
| dashboards       | exactly 2, fixed identifiers seeded by provisioning; no picker                                                                                                                                                                                                                                                                                                                                            |
| deployment       | Superset will be an **opt-in compose profile** (T6) — **currently `superset` and `superset-init` carry no `profiles:` key and start with the default stack; T4/T6 add `profiles: [reporting]` and loopback-bind the host port** (`"127.0.0.1:${SUPERSET_HOST_PORT:-8088}:8088"`), matching postgres/pgbouncer/openbao. Until T4/T6 land, a plain `docker compose up -d` starts Superset on all interfaces |
| deferred         | Celery worker/beat (async chart loading); sync-only for Stage 1 per #102                                                                                                                                                                                                                                                                                                                                  |
| out of scope     | chart authoring, user-written SQL, scheduled/emailed reports, drill-through into Records, our own date picker, dashboard picker                                                                                                                                                                                                                                                                           |

### how this follows existing platform patterns

Every mitigation above reuses a pattern already in this repo rather than introducing a new one.
Checked against the code, with the precedent named so a reviewer can compare:

| what we need                                                            | existing pattern to follow                                                                                                                                         | precedent                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cache the service-account session with TTL + explicit invalidation (P6) | the org→tenant cache: a module-level `Map`, TTL checked on read, entry deleted when stale                                                                          | `packages/auth/src/middleware.ts` — `getCachedOrgTenantId` / `setCachedOrgTenantId`                                                                           |
| retry once on a 401 after a key rotation or Superset restart (P6)       | admin-ui's fetch wrapper already does exactly this — refresh, then retry once, never loop                                                                          | `apps/admin-ui/src/lib/api.ts` — "On 401, attempt a silent token refresh and retry once"                                                                      |
| fail startup when a secret is missing or still a dev default            | conditional-required env vars expressed as Zod `.refine()` guards, not runtime `if` checks                                                                         | `packages/config/src/env.ts` — three existing refines (`SENTRY_DSN` when error tracking is on, `OPENBAO_ADDR` / `OPENBAO_TOKEN` when the provider is openbao) |
| loopback-bind the Superset host port (P3)                               | `postgres`, `pgbouncer` and `openbao` are already `127.0.0.1`-bound for this exact reason, with a `*_HOST_PORT` override var                                       | `docker-compose.yml` + the CHANGELOG entry for #454/#455                                                                                                      |
| rate limit the mint endpoint                                            | **ADR-013's three-tier shape** (per key-and-person, per key, per tenant) is the platform-wide default — so express this as a tier assignment, not a bespoke number | `docs/decisions/ADR-013-unified-rate-limiting-strategy.md`                                                                                                    |
| audit entries for views (R5)                                            | `writeAuditEntry` from `@platform/audit`, called inside the same transaction as the action                                                                         | `apps/api/src/routes/api-keys/create.ts`                                                                                                                      |
| `frame-ancestors` response header (R14)                                 | a small dedicated middleware registered in `createApp()`, alongside the existing transport-security one                                                            | `apps/api/src/middleware/https-enforcement.ts`                                                                                                                |
| isolation tests (T24)                                                   | one `*.isolation.test.ts` per surface under the api app's isolation suite                                                                                          | `apps/api/tests/isolation/` — e.g. `api-key-auth.isolation.test.ts`                                                                                           |
| digest pin + a written upgrade discipline                               | the dependency-override notes: each pin carries the reason it exists so nobody silently drops it                                                                   | `CLAUDE.md` "Maintenance notes"                                                                                                                               |

One place with **no** precedent to follow, so it needs a decision rather than a copy:
`scripts/backup.sh` dumps a single database (`POSTGRES_BACKUP_DB`, default `platform`). There is no
multi-database backup pattern in the repo — the `zitadel` metadata database is not covered either.
So R12 either extends that script to loop over a list, or accepts a second invocation; whichever is
chosen should cover `zitadel` at the same time rather than solving it once for Superset.

### telemetry

**Metrics** (Prometheus, following `packages/telemetry/src/metrics.ts`'s existing style like
`http_requests_total`/`http_request_duration_seconds`, and the existing `billing_tenant_usage`
gauge's precedent for a `tenant_id` label):

| metric                              | type      | labels                                                        |
| ----------------------------------- | --------- | ------------------------------------------------------------- |
| `reporting_mint_total`              | counter   | `tenant`, `dashboard`, `result` (success/unavailable/refused) |
| `reporting_mint_duration_seconds`   | histogram | `dashboard`, `cache_hit`                                      |
| `reporting_session_cache_hit_ratio` | gauge     | —                                                             |
| `reporting_active_tenants_total`    | gauge     | —                                                             |

`reporting_active_tenants_total` counts tenants that have minted at least once recently, for
capacity planning — there is no `reporting_enabled_tenants_total`, since R8's per-tenant
enablement flag was removed (decided 2026-09-09) and there is nothing to count as "enabled".

**Tracing.** OTel auto-instrumentation (`packages/telemetry/src/instrumentation.ts` — already turns
on auto-instrumentation for outgoing HTTP, Postgres and Redis) already covers the Superset HTTP
calls and cache calls with zero extra code — checked, there is no hand-written span anywhere else in
this repo, so this feature should not be the first place to add one. The only real gap: the
auto-generated spans do not carry tenant/dashboard/cache-hit as attributes. Task: attach those
attributes to the current active span (`trace.getActiveSpan()?.setAttributes(...)`) at the point in
`guest-token.ts` where they're known, rather than building new manual spans.

**Alerting.** Three new Prometheus alert rules in `docker/observability/alert.rules.yml`'s style
(matching existing rules like `HttpErrorRateHigh`/`HttpLatencyHigh` — expr + `for:` +
`severity`/`team: platform` labels + summary/description annotations):

- `reporting_mint_total{result="unavailable"}` rate spiking — Superset unreachable
- `reporting_mint_duration_seconds` p99 latency, mirroring `HttpLatencyHigh`
- `reporting_session_cache_hit_ratio` dropping — the most important of the three, since a silent
  cache failure looks like ordinary load otherwise

**Structured logging.** `guest-token.ts` currently has exactly one log call,
`logger.error({err, tenantId, dashboard}, "reporting: failed to mint Superset guest token")`, only
on failure. Add:

- an INFO log on every successful mint:
  `logger.info({tenantId, dashboard, cacheHit}, "reporting: guest token minted")`
- a WARN log inside the catch block, alongside the existing error log, with more detail:
  `logger.warn({tenantId, dashboard, supersetStatus, durationMs}, "reporting: Superset call failed")`

Never log the actual guest token or the service-account session credential.

## §I Interfaces

### Part 1 — what the user sees

### navigation and access

| surface      | value                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| nav item     | **Reporting**, in the sidebar after Analytics                                                           |
| route        | `/reporting`                                                                                            |
| visible when | always — reporting is always-on for every tenant, no per-tenant switch (R8 removed, decided 2026-09-09) |
| roles        | all roles — admin/agent get both tabs, customers get My Performance only (D4)                           |

### screen layout

Admin/agent: one page, two tabs — **Tenant Overview** (default), **My Performance**.
Customer: the same page with **no tab strip**, showing My Performance only.

```
┌──────────────────────────────────────────────────────────────┐
│  Reporting                    [ Tenant Overview ] [ My Perf ]│
├──────────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐      │  KPI row
│  │  Open  │ │Overdue │ │ Closed │ │ Median │ │ Stale  │      │  (5 cards)
│  │  128   │ │   14   │ │   37   │ │ 3.2 d  │ │   9    │      │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘      │
├──────────────────────────────────────────────────────────────┤
│  Inflow vs outflow (line)      │  Open by state (bar)        │
├────────────────────────────────┼─────────────────────────────┤
│  Backlog ageing (bar)          │  Time in state (bar)        │
├────────────────────────────────┼─────────────────────────────┤
│  Workload by assignee (bar)    │  Oldest open items (table)  │
└──────────────────────────────────────────────────────────────┘
```

Layout rules follow Power BI's dashboard guidance: fits one screen without scrolling, highest-level
figures top-left, one KPI row then at most eight tiles, bar for comparison, line for trend, and
**no pie, donut or gauge**.

### Tab 1 — Tenant Overview _(admin / agent only)_

Answers: _how much work is on us, what is late, are we keeping up, where do things stall._

| tile                                        | question it answers                 | chart                |
| ------------------------------------------- | ----------------------------------- | -------------------- |
| Open items                                  | how much work is sitting on us      | KPI card             |
| Overdue now                                 | what needs escalating today         | KPI card             |
| Closed this period                          | are we shipping                     | KPI card             |
| Median cycle time                           | how long things take end to end     | KPI card             |
| Stale (no update 7d+)                       | what has quietly stalled            | KPI card             |
| Inflow vs outflow per day                   | are we keeping up or falling behind | dual line            |
| Open items by state                         | where the work is sitting           | stacked bar          |
| Backlog ageing (0-2d / 3-7d / 8-30d / 30d+) | is anything rotting in the queue    | stacked bar          |
| Time in state per state                     | which step eats the cycle time      | horizontal bar, desc |
| Workload by assignee                        | is work distributed fairly          | horizontal bar, desc |
| Oldest open items                           | the actual list to act on           | table                |

### Tab 2 — My Performance _(all roles, including customers)_

Answers: _what is on my plate, what should I do first, am I keeping pace._

Scope is **assigned to me or created by me** (R3, decided 2026-09-09 — narrower than the
platform's full "my work" definition, which also includes granted/mentioned; that leg is
architecturally unreachable here since it lives in `fields.__accessUsers`, which no tile may read).
Not assigned-only, so the numbers agree with the personal dashboard elsewhere in the product on
the assigned/created subset.

| tile                                  | question it answers          | chart                |
| ------------------------------------- | ---------------------------- | -------------------- |
| My open items                         | what is on my plate          | KPI card             |
| My overdue                            | what to do first             | KPI card + table     |
| My closed this period vs last         | am I keeping pace            | KPI card with change |
| My median cycle time vs tenant median | am I slow, or is the process | comparison bar       |
| My oldest open item                   | am I neglecting something    | KPI card             |
| My activity per day                   | effort trend                 | line                 |

Per-person figures appear on that person's own tab only — **never** as a leaderboard on Tenant
Overview. Dynamics 365's own documentation warns that per-agent analytics must not drive
employment decisions.

### what each state looks like

| state                    | what the user sees                                                      |
| ------------------------ | ----------------------------------------------------------------------- |
| normal                   | tabs + populated charts                                                 |
| loading                  | skeleton placeholder in the panel, not a blank box                      |
| Superset unavailable     | "Reporting is not available right now" + a retry action                 |
| SLA not configured       | the SLA tiles show "configure SLAs to enable" (P4)                      |
| workflow has no states   | that tile shows "not configured" — never a zero that reads as real data |
| user involved in nothing | My Performance shows an explicit empty state                            |

### tiles that cannot be built, and why

Stated so nobody promises them in a demo.

| metric                               | why not                                                 | what we offer instead                                           |
| ------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| First response time                  | no reply/comment timestamp exists                       | _time to first transition_, labelled as such — never called FRT |
| Priority / amount / category splits  | live in `fields` JSONB, excluded by ADR-001             | nothing, without a policy change                                |
| Reopen rate                          | no flag; only inferable as a terminal→non-terminal edge | possible later, fragile                                         |
| Approval vs rejection rate           | no flag — only the state _name_ distinguishes them      | defer; naming-dependent                                         |
| Historical backlog trend             | only _current_ state is stored                          | replay events, or add a nightly snapshot table                  |
| CSAT, cost per item, agent idle time | no source data                                          | out of scope                                                    |

### Part 2 — how it works

### the request flow

1. User opens `/reporting`. The page checks the user's role (reporting is always-on for every
   tenant — R8's per-tenant enablement was removed 2026-09-09).
2. The page asks our API for an embed pass for the chosen dashboard.
3. Our API authenticates the caller (Zitadel), then talks to Superset **as the service account**:
   log in → obtain a CSRF token **and its session cookie** → request a guest token carrying the row
   filters. The cookie must be returned with the token or Superset rejects the request.
4. Our API returns `{ token, dashboardId, supersetDomain }`. The service-account credential never
   leaves the backend.
5. The sdk mounts the iframe and renders. It reads the token's own expiry and re-requests before it
   lapses — **never a hardcoded interval**.

```
GET /superset/guest-token?dashboard=tenant|user
→ 200 { data: { token, dashboardId, supersetDomain } }
→ 400 unknown dashboard   → 401 unauthenticated
→ 404 caller's role no longer qualifies, or the dashboard/tenant is not reachable (never a 403)
→ 502 { error: "REPORTING_UNAVAILABLE" }   — Superset unreachable
```

`tenantId`/`userId` come from the verified JWT only, never a query param.

### row filters

Filters are attached when the pass is minted, per dataset:

- `tenant_id = <caller's tenant>` on **every** dataset
- the involved-user predicate additionally on the per-user dashboard, and only on datasets that
  carry the relevant columns

Two rules matter. A filter with no dataset named is applied by Superset to _every_ dataset, and the
clause is injected as raw SQL with no column checking — so a filter naming a column a dataset lacks
breaks that chart. And a dataset that **no** filter matches gets no filtering at all. Therefore:
**every dataset on a dashboard must be covered by a filter, or the request is refused.** Dataset
identifiers are resolved by name at runtime, because they are per-environment integers.

### identifiers

Superset holds two identifiers per dashboard: the dashboard's own id, and a separate _embedded_
id created when embedding is enabled for it. **The embedded id is the one used** — for the pass's
resource scope and for the iframe. The mint endpoint accepts either, but access checks only accept
the embedded id, so the wrong one yields a valid pass that can read nothing.

### passes and revocation

Short-lived, **60 seconds**. A pass cannot be revoked mid-life, so 60s bounds the window after
disabling a user, tenant or the connector. Cost: a refresh roughly every 55s per open dashboard,
each being three Superset calls including a password hash — which is why the endpoint is rate
limited.

### provisioning

Enabling reporting for a deployment registers the data connection (read-only role), creates the two
dashboards with fixed identifiers, marks them embeddable, restricts embedding to the deployment's
own origin, and grants the guest role read-only permissions on a **dedicated** role — never
Flask-AppBuilder's anonymous `Public` role. Idempotent: re-running never rotates identifiers.

Dashboards, charts and datasets are exported as YAML into the repo, so a lost Superset volume does
not lose the work.

### configuration

| var                                                  | purpose                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `SUPERSET_SITE_URL`                                  | browser-facing origin for the iframe — must be host-reachable |
| `SUPERSET_INTERNAL_URL`                              | API→Superset; the docker service name under compose           |
| `SUPERSET_SERVICE_ACCOUNT_USER` / `_PASSWORD`        | mint-only service account                                     |
| `SUPERSET_SECRET_KEY`, `SUPERSET_GUEST_TOKEN_SECRET` | Superset-side keys                                            |

Two URLs are required, not one: inside a container `localhost` is that container. No secret may
carry a usable default — startup fails if production still holds a development value, otherwise a
deployment that forgets one runs on a published signing key and passes can be forged offline.

## §SC Screen Content Spec

What appears on every screen, per role. Written 2026-09-09 by reading the shipped code, not this
spec's intent — where the two disagree, both are shown and the divergence is linked to its open
question.

**How to read the status column:**

| marker         | meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| **built**      | verified present in the repository, `file:line` given                        |
| **specified**  | described in this doc, **not** found in the code — a target, not a behaviour |
| **assumption** | not verifiable from the repo; stated so it can be confirmed or struck        |

Two facts govern every screen below and are stated once rather than repeated per row:

- **SC-A1 — no chart exists yet (OQ-6).** `bootstrap.py` creates two dashboards and zero `Slice`
  rows. Every tile inventory in §I is therefore **specified**, never **built**. Whatever a user sees
  inside the iframe today is an empty dashboard frame, not the tables below.
- **SC-A2 — the data a tile _could_ show is bounded by two registered datasets.** Only
  `entity_instances` and `workflow_events` are registered (`bootstrap.py`), so no tile can show
  anything outside those two tables — and no tile can read `fields` JSONB (§C), which excludes
  priority, category, amount and the `__accessUsers` grant list.

### SC-1 — Screen inventory

| #   | Screen                                     | Route                     | admin   | agent   | customer (`user`) | status                                                                                                                    |
| --- | ------------------------------------------ | ------------------------- | ------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| S1  | Sidebar nav item "Reporting"               | —                         | visible | visible | **hidden**        | **built** — `apps/admin-ui/src/components/layout.tsx:153-160`, in `ADMIN_NAV`; customers return before that array renders |
| S2  | Reporting page shell (heading + tab strip) | `/reporting`              | yes     | yes     | **never reached** | **built** — `apps/admin-ui/src/pages/reporting.tsx`                                                                       |
| S3  | Tab 1 — Tenant Overview (embedded iframe)  | `/reporting`, default tab | yes     | yes     | no                | **built** (frame only, SC-A1)                                                                                             |
| S4  | Tab 2 — My Performance (embedded iframe)   | `/reporting`, second tab  | yes     | yes     | no                | **built** (frame only, SC-A1)                                                                                             |
| S5  | Failure panel                              | `/reporting`              | yes     | yes     | n/a               | **built**                                                                                                                 |
| S6  | Customer redirect                          | `/reporting` → `/records` | n/a     | n/a     | yes               | **built**                                                                                                                 |
| S7  | "Reporting is not set up" page             | `/reporting`              | —       | —       | —                 | **REMOVED** — no on/off switch is being built, see R8 removal, decided 2026-09-09 (OQ-14)                                 |
| S8  | Loading skeleton                           | `/reporting`              | —       | —       | —                 | **specified only** — see SC-5                                                                                             |

### SC-2 — S2/S3/S4, admin and agent: what is on the page

Everything outside the iframe is ours; everything inside it is Superset's.

| Region          | Content                                                                                                                                                                                                 | Source                        | Status                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| Page heading    | Static text "Reporting"                                                                                                                                                                                 | hardcoded                     | **built** — `reporting.tsx`                                  |
| Tab strip       | Exactly two pill buttons, "Tenant Overview" and "My Performance". Both always rendered for anyone who reaches the page. Active tab styled; no counts, no badges.                                        | hardcoded `["tenant","user"]` | **built**                                                    |
| Dashboard panel | A single `640px`-tall mount point. The Superset SDK owns everything inside it. Dashboard title is suppressed (`hideTitle: true`) and the filter bar renders collapsed (`filters: { expanded: false }`). | `@superset-ui/embedded-sdk`   | **built**                                                    |
| Failure panel   | Replaces the panel entirely with one sentence: _"Reporting is not available right now. Try again shortly."_ No retry button — the user must switch tabs or reload.                                      | `reporting.tsx` catch block   | **built**; §I promises "a retry action" — **specified only** |

**SC-2a — the tab strip is rendered before the role check resolves.** Role detection is async
(`userManager.getUser()`), so a customer briefly sees the Reporting page and its tabs before the
redirect fires. Cosmetic today because no data loads first, but it is a real flash of a surface they
are not entitled to. Not currently tracked by a requirement.

### SC-3 — S3, Tenant Overview: what data it shows

|                      |                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Superset embedded id | `f3823557-5d58-4c78-b36f-4d3faeb57012` — **built**, `apps/api/src/routes/reporting/dashboard-ids.ts`                                           |
| Row filter applied   | `tenant_id = '<caller's tenantId from JWT>'` — **built**, `guest-token.ts` `buildRlsRules`                                                     |
| Filter scope         | **Unscoped by dataset** — the rule carries no `dataset` key, so Superset applies it to every dataset on the dashboard. **built**, and see OQ-9 |
| Datasets reachable   | `entity_instances`, `workflow_events` — **built**, `bootstrap.py`                                                                              |
| Tiles present        | **none** — SC-A1                                                                                                                               |
| Tiles intended       | the 11 tiles in §I "Tab 1" — **specified only**                                                                                                |

**Assumption SC-A3:** the tenant filter is sufficient for this dashboard because every tile is
intended to be tenant-wide. That holds only while both registered datasets carry a `tenant_id`
column — verified true for `entity_instances` and `workflow_events` today, and it would silently
stop holding if a third dataset without that column were registered. Nothing in the code enforces
it; §R5's coverage refusal is **specified only**.

### SC-4 — S4, My Performance: what data it shows

|                          |                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Superset embedded id     | `f3823557-5d58-4c78-b36f-4d3faeb57013` — **built**                                                                                                                                                              |
| Row filters applied      | Two rules: `tenant_id = '<tenantId>'` **and** `assigned_to = '<userId>'` — **built**, `guest-token.ts`                                                                                                          |
| Scope actually delivered | **assigned-to-me only**                                                                                                                                                                                         |
| Scope this spec requires | assigned **or** created only (§R3, decided 2026-09-09 — OQ-8) — **specified only**; "created" is not yet implemented, but the scope is architecturally buildable as written now that "granted" has been dropped |
| Known defect             | `assigned_to` does not exist on `workflow_events`, and the filter is not dataset-scoped, so the first workflow_events-backed tile added here will break (OQ-9)                                                  |
| Tiles present            | **none** — SC-A1                                                                                                                                                                                                |
| Tiles intended           | the 6 tiles in §I "Tab 2" — **specified only**                                                                                                                                                                  |

Both ids used in the filters come from the verified JWT and are regex-validated before being
interpolated into the raw SQL clause — `UUID_RE` for the tenant, `PRINCIPAL_ID_RE` for the principal
(**built**, `guest-token.ts`). This is load-bearing: a Superset RLS clause has no parameterized form.

### SC-5 — Screen states, as built vs. as specified

§I lists seven states. Only three exist.

| State                    | §I says                           | Actually renders                               | Status                  |
| ------------------------ | --------------------------------- | ---------------------------------------------- | ----------------------- |
| normal                   | tabs + populated charts           | tabs + an empty dashboard frame                | **built** / SC-A1       |
| loading                  | skeleton placeholder in the panel | an empty `640px` div — no spinner, no skeleton | **specified only**      |
| Superset unavailable     | message + retry action            | message, **no retry action**                   | partially **built**     |
| SLA not configured       | "configure SLAs to enable"        | no tile exists to show it                      | **specified only** (P4) |
| workflow has no states   | tile shows "not configured"       | no tile exists to show it                      | **specified only**      |
| user involved in nothing | explicit empty state              | Superset's own empty rendering, unstyled by us | **specified only**      |

The failure panel deliberately leaks nothing — no host, status code or service-account identity
reaches the browser; the API returns a flat `502 REPORTING_UNAVAILABLE` and the UI substitutes its
own sentence (**built**, satisfies R7's non-disclosure clause).

### SC-6 — Customer (`user` role): what they see

| Surface                       | Behaviour                                                                                                                                                                                              | Status                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Sidebar nav item              | **Not visible.** The entry lives in `ADMIN_NAV`, and customers return before that array is rendered.                                                                                                   | **built** — `layout.tsx:153-160` |
| `/reporting` (typed directly) | Redirects to `/records` once roles resolve. No tab strip, no iframe, no message explaining the redirect. This is defence-in-depth for direct URL entry, not dead code — the nav never offers the link. | **built** — `reporting.tsx`      |
| Guest-token API               | Refused. `requireRole("agent","admin")` rejects the customer before any mint is attempted.                                                                                                             | **built** — `guest-token.ts`     |
| My Performance for customers  | Not delivered. §D4/§R4 promise it.                                                                                                                                                                     | **specified only** (OQ-7)        |

Role detection classifies a caller as a customer when the JWT roles include `user` **or** `customer`
and include neither `admin` nor `agent` (**built**, `reporting.tsx`). Note `customer` is not one of
the role names found elsewhere in the codebase (`admin`, `agent`, `user`, `superadmin`) — the
UI accepts it defensively.

**The refusal is genuinely server-side**, which is the part of R4 that matters: a customer crafting
`GET /superset/guest-token?dashboard=tenant` is rejected by role, not merely hidden in the UI. What
is _not_ satisfied is the other half of R4 — they get nothing at all rather than a scoped tab.

### SC-7 — Assumption register for this section

Every assumption made above, in one place, so a reviewer can strike them individually.

| ID        | Assumption                                                                                              | Why it is an assumption                                                                                                                                                                                                      | If wrong                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| SC-A1     | Users currently see an empty dashboard frame, not an error, when the iframe loads a chartless dashboard | Not observed against a running instance — inferred from `bootstrap.py` creating no `Slice` while `position_json` references `chartId: 1`/`2`. A dangling chart reference may render as an error tile instead of empty space. | The "normal" state in SC-5 is wrong; S3/S4 show a broken dashboard, which is a worse first impression and changes T27/T28's priority |
| SC-A2     | No tile can show data outside `entity_instances` and `workflow_events`                                  | True of the registered datasets today; a chart author with Superset access could register more without touching this repo                                                                                                    | The dataset-coverage reasoning in SC-3 and OQ-9 needs redoing against the new surface                                                |
| SC-A3     | The unscoped tenant filter is safe because both datasets carry `tenant_id`                              | Verified for today's two datasets only; nothing enforces it                                                                                                                                                                  | An uncovered dataset returns every tenant's rows — the §S "HTTP 200, no error" threat                                                |
| ~~SC-A4~~ | ~~The Reporting nav item is visible to customers~~                                                      | **Refuted 2026-09-09.** Verified at `layout.tsx:153-160` — the item is in `ADMIN_NAV` and customers never render that array. SC-1/SC-6 now state this as fact.                                                               | —                                                                                                                                    |
| ~~SC-A5~~ | ~~Superset's default guest-token lifetime applies, since none is configured~~                           | **Refuted 2026-09-11.** T16 now explicitly requires setting `GUEST_TOKEN_JWT_EXP_SECONDS = 60` in `superset_config.py`. The assumption no longer holds once T16 is implemented.                                              | —                                                                                                                                    |

---

## §F Data Flow

One request, end to end. Every hop below is **built** unless the box says otherwise.

### F-1 — The mint-and-render path

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ BROWSER — admin-ui                                                           │
 │                                                                              │
 │  Zitadel session (OIDC, oidc-client-ts)                                      │
 │        │ access token (localStorage)                                         │
 │        ▼                                                                     │
 │  reporting.tsx  ──(1) GET /superset/guest-token?dashboard=tenant|user────┐   │
 │        ▲                                    Authorization: Bearer <jwt>  │   │
 │        │ (5) { token, dashboardId, supersetDomain }                      │   │
 └────────┼─────────────────────────────────────────────────────────────────┼───┘
          │                                                                 ▼
 ┌────────┴─────────────────────────────────────────────────────────────────────┐
 │ OPENWIND API — apps/api/src/routes/reporting                                 │
 │                                                                              │
 │  (2) requireAuth()          → JWKS verify, tenantId + userId from claims     │
 │      requireRole(agent,admin) → customer refused here          [OQ-7]        │
 │      zValidator(query)      → dashboard ∈ {tenant, user}                     │
 │                                                                              │
 │  (3) buildRlsRules()        → tenant: [ tenant_id = '<tenantId>' ]           │
 │      UUID_RE / PRINCIPAL_ID_RE   user: [ tenant_id = '…',                    │
 │      validate before interpolation        assigned_to = '<userId>' ]  [OQ-8] │
 │                              ⚠ no dataset key on either rule          [OQ-9] │
 │                                                                              │
 │  (4) mintGuestToken()  ── three calls, every request, no caching ──┐  [P6]   │
 │        SUPERSET_INTERNAL_URL only — never SITE_URL                 │         │
 └────────────────────────────────────────────────────────────────────┼─────────┘
                                                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ SUPERSET — ow-superset :8088                                                 │
 │                                                                              │
 │   4a  POST /api/v1/security/login       (service account, provider=db)       │
 │           → access_token                                                     │
 │   4b  GET  /api/v1/security/csrf_token/ → csrf token + Set-Cookie session    │
 │           ⚠ both required; token without cookie ⇒ 400 CSRF session missing   │
 │   4c  POST /api/v1/security/guest_token/                                     │
 │           Bearer + X-CSRFToken + Cookie                                      │
 │           body: { user: guest, resources:[{dashboard, <embedded uuid>}],     │
 │                   rls: [ …clauses… ] }                                       │
 │           → signed guest token (HS256, GUEST_TOKEN_JWT_SECRET)               │
 │           lifetime: 60s (T16 sets GUEST_TOKEN_JWT_EXP_SECONDS = 60)           │
 └──────────────────────────────────────────────────────────────────────────────┘
          │
          │ (5) token returned to the browser; service-account credential never leaves the API
          ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ BROWSER — @superset-ui/embedded-sdk                                          │
 │                                                                              │
 │  (6) embedDashboard({ id: <embedded uuid>, supersetDomain: SITE_URL })       │
 │        → iframe  GET {SITE_URL}/embedded/<embedded uuid>                     │
 │        → SDK re-invokes fetchGuestToken() on expiry, which repeats (1)       │
 └──────────────────────────────────────────────────────────────────────────────┘
          │
          │ (7) iframe's own API calls, bearing the guest token
          ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ SUPERSET query layer                                                         │
 │                                                                              │
 │  has_guest_access(): token resource id vs dashboard numeric id or            │
 │                      embedded_dashboards.uuid — never dashboards.uuid        │
 │  dedicated guest role grants: Dashboard/Chart/Dataset read, explore_json,    │
 │                      FilterState read+write  (T12 — R6)                      │
 │  RLS clauses ANDed into every generated query                                │
 │        ▼                                                                     │
 │  results cached in Redis db 2  ⚠ tenant rows land outside the DB      [P7]   │
 └──────────────────────────────────────────────────────────────────────────────┘
          │
          │ (8) SQLAlchemy, one shared connection
          ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ SOURCE — postgres/platform                                                   │
 │                                                                              │
 │  connection: analytics_user  ⚠ rolbypassrls = true — RLS does NOT apply [P1] │
 │  datasets:   public.entity_instances    public.workflow_events        [OQ-13]│
 │              (raw tables, not masked views; expose_in_sqllab = true)         │
 │                                                                              │
 │  ⇒ tenant separation rests on the step-3 clause ALONE. One layer, not two.   │
 └──────────────────────────────────────────────────────────────────────────────┘
```

### F-2 — Step table

| #   | From → To           | Carries                                                     | Trust boundary crossed                     | Code                              |
| --- | ------------------- | ----------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| 1   | browser → API       | Zitadel access token, `dashboard` query param               | untrusted → authenticated                  | `reporting.tsx`                   |
| 2   | API                 | tenantId, userId extracted from **verified claims only**    | —                                          | `guest-token.ts`, `packages/auth` |
| 3   | API                 | RLS clauses built and regex-validated                       | this is _the_ tenancy boundary             | `buildRlsRules`                   |
| 4   | API → Superset      | service-account credentials, CSRF token + cookie, RLS rules | backend → BI, internal network, plain HTTP | `superset-client.ts`              |
| 5   | API → browser       | guest token, embedded uuid, `SUPERSET_SITE_URL`             | BI → untrusted                             | `guest-token.ts`                  |
| 6   | browser → Superset  | guest token, in an iframe                                   | untrusted → BI                             | embedded-sdk                      |
| 7   | Superset            | access check + RLS injection + Redis cache                  | —                                          | Superset internals                |
| 8   | Superset → Postgres | SQL as `analytics_user`                                     | BI → data, **RLS bypassed**                | `bootstrap.py` connection URI     |

### F-3 — What the diagram makes obvious

- **The tenancy boundary is a single string built at step 3.** `analytics_user` has
  `rolbypassrls = true`, so Postgres will not catch a mistake. This is P1 restated as a picture:
  there is exactly one layer where `.claude/rules/security.md` rule 1 requires two. Nothing between
  step 3 and step 8 re-checks the tenant.
- **Two identifiers, and only one works.** Step 4c and step 6 both use the _embedded_ uuid. Passing
  the dashboard's own uuid mints a valid token whose every subsequent call 404s — documented as B10
  and guarded by a comment in `dashboard-ids.ts`.
- **Two URLs, and they are not interchangeable.** Steps 4a–4c use `SUPERSET_INTERNAL_URL` (docker
  service name); step 6 uses `SUPERSET_SITE_URL` (browser-reachable). Both currently default to
  `http://localhost:8088`, which makes R14's "must differ in production" check vacuous (OQ-15).
- **Step 4 repeats in full on every refresh.** Login + CSRF + mint, per open dashboard, per token
  expiry, with a password hash each time. This is P6 — the self-inflicted load problem — and no
  session cache exists in `superset-client.ts` today.
- **Data leaves the governed surface at step 7.** Query results are cached in Redis db 2, outside
  the tables the SQL grant governs, which is why retention and erasure have to cover the cache and
  Superset's volume (P7, §C data-at-rest).

**Assumption F-A1:** the SDK re-requests a token on expiry rather than on a fixed timer. The code
supplies a `fetchGuestToken` callback and never sets an interval, so the refresh policy is entirely
the SDK's; it was not verified against the SDK's source. If it is timer-based rather than
expiry-derived, §V's "pass refresh derives from the pass's own expiry, never a hardcoded interval"
is satisfied by luck, not by design.

**Assumption F-A2:** the API→Superset hop is plain HTTP. `SUPERSET_INTERNAL_URL` defaults to
`http://superset:8088` in compose and nothing upgrades it, but a deployment could set an `https://`
value. §C already conditions on this; noted here so the diagram is not read as forbidding TLS.

---

## §R Requirements

R1: reporting is reachable without any Superset-facing login
✓ no Superset login screen, prompt or credential is ever shown to a user
✓ the user's Zitadel session is the only login involved

R2: a user sees their own tenant's data and no other tenant's
✓ the pass carries a tenant filter, attached server-side before the iframe loads
✓ a pass minted for tenant A cannot be replayed to view tenant B
✓ a dataset that no filter covers causes the request to be **refused**, not served unfiltered

R3: the per-user tab scopes to work the caller is involved in
✓ assigned **or** created only — narrower than the platform's full "my work" predicate, by design
(see OQ-8: the "granted" leg lives in the `fields` JSONB column, which §C forbids any tile from
reading, so it is architecturally unreachable by reporting; this is a deliberate, permanent
narrowing for reporting specifically, not a bug to fix later — do not "fix" it by opening up the
blocked column)
✓ its figures reconcile with the personal dashboard elsewhere in the product **on the assigned/created
subset only**
✓ switching tabs re-mints; a tab never reuses the other tab's pass

R4: reporting is reachable by every role, with tabs gated per role
✓ admin/agent see both tabs; a customer sees My Performance only, with no tab strip rendered
✓ a customer cannot reach tenant-wide figures by any route, including a crafted request for the
tenant dashboard — the request is refused server-side, not merely hidden in the UI
✓ a customer's figures cover only records they are involved in

R5: a pass can never be issued unscoped
✓ every filter names its dataset
✓ a mint with no filters, or whose filters do not cover every dataset on the dashboard, is refused
✓ every mint is logged with tenant, user, dashboard and request id
✓ every view is recorded in the audit log, not only in application logs

Audit action strings, following this repo's `<thing>.<happened>` / `<thing>.<refused>` convention
(`packages/audit/src/index.ts`, migration `0089_admin_audit_log_read_actions.sql`; a new action must
be added to the DB CHECK constraint, the `AuditAction` TS union, and both exhaustiveness maps
`outcome.ts` and `request-kind.ts`, all in the same commit):

```
reporting.viewed        — a dashboard pass was minted and served successfully
reporting.view_denied   — the caller was refused (wrong role, tenant mismatch, etc.)
reporting.mint_failed   — mint attempted but Superset was unreachable or errored
```

R6: provisioning is automatic and idempotent
✓ both dashboards are registered embeddable; identifiers are stable across re-runs
✓ embedding is permitted from the deployment's own origin and nothing wider
✓ guest permissions land on a dedicated role, never the anonymous one

R7: failure degrades to a readable message
✓ Superset unreachable and mint failure each render a plain message
✓ no internal detail (host, status, service-account identity) reaches the browser
✓ a placeholder shows while loading; a retry is offered on failure
✓ failure is contained to this page

R9: revocation is prompt
✓ pass lifetime is 60s, bounding the window after any disable
✓ the mint path re-checks tenant-active on every refresh

R10: a tile never shows a misleading number
✓ unconfigured SLA, an unconfigured workflow, and genuinely-zero are visually distinguishable
✓ no tile reads a column outside the reporting grant, and none reads `fields` JSONB

R11: normal use does not overload the instance
✓ the service-account session is reused across passes, not re-established per pass
✓ concurrent requests share one refresh (single-flight), and a 401 triggers one retry so a Superset
restart or a rotated signing key recovers rather than failing the page
✓ a supported concurrent-dashboard figure is stated and load-tested, not assumed

R12: losing the Superset volume does not lose the work
✓ Superset's metadata database is included in the backup routine
✓ dashboards, charts and datasets are also exported as YAML into the repo
✓ a restore is documented and exercised at least once

R13: a leaked key has a defined remedy
✓ rotation is documented for both Superset keys, with the blast radius of each stated
✓ rotating either does not require a code change or a redeploy of admin-ui

R14: reporting adds no unprotected transport or framing surface
✓ admin-ui sends `frame-ancestors 'self'`
✓ the API→Superset hop uses TLS wherever it leaves a single host
✓ `SUPERSET_SITE_URL` and `SUPERSET_INTERNAL_URL` are validated as **different** in production —
equal values silently defeat the split and are a plausible misconfiguration

## §S Threat Model (STRIDE)

Mandatory per `.claude/rules/security.md`. P1-P3 are the load-bearing risks.

| threat | abuse case                                                                                                                                                                    | blocked by                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | forge a pass offline using a default signing secret                                                                                                                           | T5 (phase 0 — **not yet implemented**; usable defaults exist today in `packages/config/src/env.ts`; T5 removes them and adds a startup refine that fails if a production default is still set) |
| S      | replay tenant A's pass from an attacker's page                                                                                                                                | embed-origin allowlist; 60s lifetime. Passes carry no origin binding — accepted risk, stated                                                                                                   |
| R      | a user views another team's figures untraceably                                                                                                                               | R5 audit log                                                                                                                                                                                   |
| I      | a chart on an uncovered dataset returns every tenant's rows, HTTP 200, no error                                                                                               | R2/R5 refusal + P1-A                                                                                                                                                                           |
| I      | raw `workflow_events` exposes PII metadata                                                                                                                                    | P2 grant repair + the pinning test                                                                                                                                                             |
| I      | anyone on the network reaches Superset and uses SQL Lab as `admin`                                                                                                            | T4/T6 (phase 0 — **not yet implemented**; currently starts on all interfaces with default `admin`/`admin` and SQL Lab enabled)                                                                 |
| D      | mint flood — each mint is three Superset calls including a password hash                                                                                                      | rate limit per tenant, citing ADR-013's tiers                                                                                                                                                  |
| D      | **normal traffic** self-DoSes the instance: ~200 logins/min at 200 open dashboards                                                                                            | P6-A session caching + a stated, load-tested capacity figure                                                                                                                                   |
| E      | the service-account credential leaks and grants SQL Lab over every tenant                                                                                                     | least-privilege service account (§C)                                                                                                                                                           |
| E      | a forged Superset admin session via a known signing key → RCE (the CVE-2023-27524 mechanism; our 4.0.2 is unaffected by the CVE itself, but the shipped default recreates it) | T5 (phase 0 — **not yet implemented**; usable defaults exist today; T5 removes them so this attack class is closed before deployment)                                                          |
| E      | Superset is compromised and reaches the database directly over the docker network, holding its own credential                                                                 | P7 — accepted in writing today; network restriction when this leaves single-node compose                                                                                                       |
| I      | tenant rows sit in Superset's Redis result cache and its own volume, outside the masked views                                                                                 | §C data-at-rest; retention and erasure must cover both                                                                                                                                         |
| I      | admin-ui is framed by a hostile page to relay a pass within its 60s window                                                                                                    | `frame-ancestors 'self'` + a minimal iframe sandbox (§C)                                                                                                                                       |
| I      | the mint hop's session cookie is observed on an unencrypted internal network segment                                                                                          | §C transport — TLS required whenever that hop leaves a single host                                                                                                                             |

Carried as criteria: _tenant A attempts each of the above against tenant B and gets zero rows — not
an error that confirms existence._

**Accepted risk, stated explicitly:** a stolen 60-second guest token is a small, already-time-boxed
risk; the theoretical exposure route is admin-ui XSS extracting the active token during its short
window — this is a platform-wide XSS-surface concern, not specific to reporting, and is mitigated
by admin-ui's existing CSP and XSS controls.

## §V Invariants

- the tenant filter is attached server-side at mint time — never client-supplied, never UI-only
- a filter is never issued unscoped; an uncovered dataset refuses the request rather than serving it
- reporting isolation fails closed: a mistake yields no data, never another tenant's data
- the embedded identifier is used for both the pass scope and the iframe
- pass refresh derives from the pass's own expiry, never a hardcoded interval
- the service-account credential never leaves the backend
- every failure path returns the same user-facing message — no existence oracle
- provisioning is idempotent; identifiers never rotate
- configuration lives in env vars, never in the database, never entered by a user
- guest permissions never land on the anonymous role
- no tile reads a column outside the reporting grant, and none reads `fields` JSONB
- tenant data exists outside the masked views — in Superset's result cache and its own volume — so
  retention, erasure and residency questions cover those too, not just the views
- no secret ever has a usable default: a known signing key is a forged admin session, not a nit
- Superset's metadata database is backed up; the YAML export is a second copy, not the only one
- "not configured" and "zero" are always distinguishable in the UI
- the per-user tab uses assigned-or-created only, a deliberate narrowing of the platform's full
  "my work" definition (R3, decided 2026-09-09) — not the platform's single definition verbatim
- per-person figures appear only on that person's own tab
- tiles are exported to the repo; the Superset volume is never the only copy
- views must be `security_invoker` so RLS actually applies through them, not just to direct table
  access (P1b)
- every user, including platform-admin roles, is scoped to their authenticated Zitadel org for
  reporting purposes — there is no cross-tenant view for any role

## §T Tasks

### phase 0 — settle the boundary and close the surface

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | owner                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| T1  | **ADR: reporting tenant-isolation boundary** — choose P1 A/B/C. Human-authored (agents may not write ADRs); blocks phase 2 entirely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **owner: Bikash, date: 2026-09-09** |
| T2  | implement the chosen isolation model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | TBD                                 |
| T3  | **GH issue required (none exists yet) — open one before implementation.** re-assert migration 0009's grant allowlist + a test pinning the granted table set (P2) — generate the concrete table list from the live grants (confirmed 34 tables), not hand-typed, and commit it into the spec/migration so the pinning test has an exact set to diff against. **Re-verify the grant count before committing it — PRs #583/#585/#586 added 8 tables (teams, services, on_call_schedules, labels, ticket_labels, notification_policies, schedule_rules, schedule_executions); those PRs add no `analytics_user` grants on operational tables so 34 may still be correct, but the spec must record "re-verified as of \<date\>" rather than cite a stale count** | TBD                                 |
| T3b | **set `security_invoker = true` on `workflow_events_masked` and any other reporting view, in the SAME migration as T3** — the querying role needs its own read grant on the underlying base table columns once this is on (P1b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | TBD                                 |
| T4  | loopback bind, mandatory admin password, SQL Lab off (P3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | TBD                                 |
| T5  | remove usable secret defaults; fail startup on a production default (closes the CVE-2023-27524 attack class, P7). Unit test in `packages/config/src/env.test.ts` asserting both `SUPERSET_SECRET_KEY` and `SUPERSET_GUEST_TOKEN_SECRET` are rejected when still set to their development default — this is the first such test for a Superset secret, not a repeat of an existing one                                                                                                                                                                                                                                                                                                                                                                       | TBD                                 |
| T6  | opt-in compose profile; digest-pin the images **and record a re-pin/CVE-check cadence**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | TBD                                 |
| T7  | mandatory generated admin password, stored like every other platform credential                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | TBD                                 |
| T8  | add the `superset` metadata database to `scripts/backup.sh`; document a restore (R12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | TBD                                 |
| T9  | `frame-ancestors 'self'` on admin-ui; minimal embed-iframe sandbox (R14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | TBD                                 |
| T10 | accept the P7 blast radius in writing, or add the network restriction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **owner: Bikash, date: 2026-09-09** |

### phase 1 — the mechanism

| id   | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | depends                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| T11  | Superset service, own metadata database, cache index, config                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T4,T6                  |
| T12  | provisioning: data connection, two dashboards, embeddability, dedicated guest role (must create a new role, set `GUEST_ROLE_NAME` to that role's name in `superset_config.py`, and remove the `"Public"` assignment — R6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | T2,T11                 |
| T13  | `GET /superset/guest-token` — service-account login → CSRF(+cookie) → filtered pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T12                    |
| T14  | **cache the service-account session** with single-flight refresh and retry-once-on-401 (P6-A, R11). Unit tests: cache hit skips Superset login; concurrent requests share one refresh, not N; a 401 triggers one retry and invalidates the cache before re-login; expired TTL triggers a refresh — same discipline `getCachedOrgTenantId` already has, this cache is new and race-prone enough to need the same coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T13                    |
| T15  | dataset-scoped filters, resolved by name, with **coverage refusal** (R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T13                    |
| T16  | 60s pass lifetime + rate limit (R9): set `GUEST_TOKEN_JWT_EXP_SECONDS = 60` in `superset_config.py` to make the lifetime explicit rather than relying on the Superset default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T13                    |
| T17  | state and load-test a supported concurrent-dashboard figure: **200 concurrent dashboards** (R11); route Superset's database connection through `ow-pgbouncer` rather than direct-to-Postgres; the load test's acceptance criteria must watch connection counts against pgbouncer, not just response latency — running out of connections is the realistic failure mode at this concurrency and surfaces as unrelated-looking errors elsewhere in the platform                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T14, pgbouncer routing |
| T19  | admin-ui page: two tabs (one for customers), sdk mount, role scoping, loading and failure states (R7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | T15                    |
| T20  | audit-log entries for views (R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                      |
| T21  | key-rotation procedure for both Superset keys, with blast radius stated (R13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T14                    |
| T22  | validate `SUPERSET_SITE_URL` ≠ `SUPERSET_INTERNAL_URL` in production (R14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                      |
| T23  | TLS on the API→Superset hop wherever it leaves a single host (R14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                      |
| T24  | isolation tests: cross-tenant replay, disabled tenant (tenant suspension — `resolveTenantStatus`/`TENANT_SUSPENDED`, `packages/auth/src/middleware.ts`), uncovered-dataset refusal, unscoped read returns zero rows, customer refused the tenant dashboard, role downgrade reflected on next mint (an agent downgraded to customer between two dashboard opens must get 404 on the next mint of the tenant dashboard, not a cached/stale role check), `tenantId`/`userId` supplied via query param or body instead of the verified JWT must be refused (already correctly implemented — `guest-token.ts` only reads `c.get("auth")`, the query schema only accepts `dashboard` — this test locks in existing correct behaviour), DB-layer test: query `workflow_events_masked` (and any other reporting view) directly as the reporting role with no `app.tenant_id` set — must return zero rows, proving the view's `security_invoker` setting (P1b) is doing real work, not just passing app-layer tests that go through the API's own filter | T15                    |
| T25  | e2e test for the route — mandatory for `apps/api`. Fixtures use **real issued id shapes** (Zitadel numeric subject, `apikey:<uuid>`), never invented look-alikes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | T15                    |
| T25b | role-recheck at mint time: re-check the caller's CURRENT role via a live DB lookup, not just the JWT claim baked in at login; refuse with 404 if it no longer qualifies, matching the existing pattern of failing closed with 404 (not 403) for authorization mismatches — closes the gap where `requireRole("agent","admin")` only checks the role in the JWT, which is stale if the role changes mid-session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | T13                    |
| T25c | GDPR/privacy-deletion: `apps/worker/src/tenant-purge.ts` (checked, confirmed) has no awareness of Superset's Redis result cache or its export volume — a tenant privacy deletion today clears the platform DB but leaves cached copies in Superset untouched. Configure Superset's Redis result-cache TTL to expire within the platform's deletion SLA, rather than selectively purging cached entries per tenant; document the chosen TTL number here once set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                      |
| T25d | telemetry: `reporting_mint_total`/`reporting_mint_duration_seconds`/`reporting_session_cache_hit_ratio`/`reporting_active_tenants_total` metrics; tenant/dashboard/cache-hit attributes on the active OTel span in `guest-token.ts`; the three new alert rules; the INFO/WARN log additions (see §C telemetry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | T13,T14                |

### phase 2 — the views

| id  | task                                                                                                                    | depends |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| T26 | seed demo data — no tile is signed off against 3 records (P5)                                                           | —       |
| T27 | Tenant Overview tiles                                                                                                   | T15,T26 |
| T28 | My Performance tiles on the involved predicate                                                                          | T15,T26 |
| T29 | empty / not-configured states for every tile (R10)                                                                      | T27,T28 |
| T30 | export dashboards, charts and datasets to YAML in-repo + documented re-import (R12)                                     | T27,T28 |
| T31 | connector status surface + Connectors card — **status only**, no enable/disable switch (R8 removed, decided 2026-09-09) | —       |
| T32 | SLA tiles, once `sla_hours` is configurable and set (P4)                                                                | T27     |

phase gate: phase 0 completes before phase 1. T1/T2 gate the tiles — building views on a boundary
that is about to change is wasted work. Every phase must pass
`typecheck` + `lint` + `test` + `test:isolation`.

## Open Questions

For the reviewer. Each of these is a decision this spec deliberately does **not** make — either
because it is above an engineering call, or because the repo has no existing pattern to copy and
inventing one unreviewed is how the last round of mistakes happened.

| ID   | Question                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Which isolation option do we take — A (tenant-scoped views on a non-bypass role), B (per-tenant DB credential), or C (Superset's own rules)? Who owns the ADR, and by when?       | **Decided 2026-09-09, owner: Bikash.** Option A, resolved via `DB_CONNECTION_MUTATOR` stamping `app.tenant_id` per connection and relying on existing RLS — see §P1 and §P1b. C is a trap because an unattached table returns every tenant's rows. This gates every tile — phase 2 cannot start without it.                                                                                 |
| OQ-2 | Do we extend `scripts/backup.sh` to cover multiple databases, or accept a second invocation for Superset's metadata?                                                              | **No precedent in the repo** — the script dumps one database (`POSTGRES_BACKUP_DB`, default `platform`), and there is no multi-database backup pattern to copy. Note the `zitadel` metadata database is **also** not backed up today, so whichever shape is chosen should cover it in the same change rather than solving this only for Superset.                                           |
| OQ-3 | Is "one Superset instance per deployment, so a compromise reaches every tenant" an accepted risk in writing, or does it need a network-layer restriction alongside the SQL grant? | §P7. Verified: the Superset container reaches `postgres:5432` directly, so loopback-binding the browser port does not reduce what Superset itself can reach. Recommendation is to accept it explicitly now and revisit when this leaves single-node compose.                                                                                                                                |
| OQ-4 | What concurrent-dashboard count must Stage 1 support, and who load-tests it?                                                                                                      | **Decided 2026-09-09: 200 concurrent dashboards.** R11/P6. A 60s pass lifetime means a refresh per open dashboard roughly every 55s. Session caching (P6-A) removes the per-pass login. At this concurrency, Superset's `NullPool` behaviour means the database connection must route through `ow-pgbouncer` (T17); the load test must watch pgbouncer connection counts, not just latency. |
| OQ-5 | Who owns the Superset CVE watch and the re-pin cadence?                                                                                                                           | Digest-pinning without a re-pin process freezes today's exposure. The repo's dependency-override notes in `CLAUDE.md` are the closest discipline to align with.                                                                                                                                                                                                                             |

### Raised while writing §SC and §F (2026-09-09)

These came out of reading the shipped code against this spec. **Every one is a divergence between what
this document describes and what the repository currently does** — so §SC and §F below document the
_current_ behaviour and mark the spec's intent separately. None of these are answered here.

| ID        | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-6      | **Neither dashboard contains any chart. What is the intended tile inventory, and who builds it?** `docker/superset/bootstrap.py` creates both dashboards and imports `Slice`, but never instantiates one. Both `position_json` values reference `chartId: 1` / `chartId: 2`, which do not exist. So §I's tile tables are **design intent, not shipped content**, and "what each screen shows" today is: an empty dashboard frame.                                                                                                                                                                                                       | `docker/superset/bootstrap.py` — `Slice` imported at the `superset.models.slice` import, never constructed; `position_json='{"CHART-1":...{"chartId":1}...}'` for tenant, `chartId: 2` for user. No `SqlMetric` or `TableColumn` is created either, despite both being imported.                                                                                                             |
| OQ-7      | **Do customers get reporting at all?** §D4 and §R4 say a customer sees a single My Performance tab. The code refuses them in **two** places: the API requires `agent` or `admin`, and the UI redirects a customer to `/records` before mounting anything. Is D4 the target and the code is behind, or has D4 been superseded?                                                                                                                                                                                                                                                                                                           | `apps/api/src/routes/reporting/guest-token.ts` — `requireRole("agent", "admin")`. `apps/admin-ui/src/pages/reporting.tsx` — `if (customer) navigate("/records", { replace: true })`.                                                                                                                                                                                                         |
| OQ-8      | **Is "My Performance" assigned-only or involved?** §R3 requires assigned **or** created **or** granted, reconciling with the personal dashboard. The shipped filter is `assigned_to = '<userId>'` alone. Changing it means the RLS clause must express created-by and the `__accessUsers` grant, and `__accessUsers` lives in `fields` JSONB — which §C forbids any tile from reading. These two requirements may be in direct conflict.                                                                                                                                                                                                | **Resolved 2026-09-09.** R3 is narrowed to assigned **or** created only, permanently — the "granted" leg is architecturally unreachable since `__accessUsers` lives in `fields` JSONB, which §C forbids any tile from reading. `guest-token.ts` — `rules.push({ clause: \`assigned_to = '${userId}'\` })`. `fields.\_\_accessUsers`per`packages/workflow-engine/src/entity-access.ts:34-36`. |
| OQ-9      | **The user dashboard's filter names a column one of its two datasets does not have.** `assigned_to` exists on `entity_instances` (`packages/db/src/schema/entity-engine.ts:77`) but **not** on `workflow_events` (`packages/db/src/schema/workflow-engine.ts:113-154`). The rules carry no `dataset` key, so per this spec's own §I row-filters note Superset applies them to _every_ dataset. Any future workflow_events-backed chart on the user dashboard will therefore fail. Is the fix dataset-scoped rules (§R5), a view exposing `assigned_to`, or no workflow_events charts on that dashboard?                                 | `guest-token.ts` `buildRlsRules` emits `{ clause }` only — no `dataset` field.                                                                                                                                                                                                                                                                                                               |
| ~~OQ-10~~ | ~~What is the actual guest-token lifetime?~~ **Decided 2026-09-11: T16 will set `GUEST_TOKEN_JWT_EXP_SECONDS = 60` in `superset_config.py`.** R9's 60s revocation window is correct once T16 is implemented. SC-A5 refuted. §F diagram updated to remove the [OQ-10] annotation.                                                                                                                                                                                                                                                                                                                                                        | `docker/superset/superset_config.py` — sets `GUEST_TOKEN_JWT_SECRET` and `GUEST_TOKEN_JWT_ALGO`, no exp setting today (T16 adds it).                                                                                                                                                                                                                                                         |
| ~~OQ-11~~ | ~~Guest permissions are on `Public`.~~ **Decided 2026-09-11: R6 stands.** T12 must create a dedicated guest role and set `GUEST_ROLE_NAME` away from `"Public"` in `superset_config.py`. The `bootstrap.py` `guest_role_name = current_app.config.get("GUEST_ROLE_NAME", "Public")` call is correct once the config key is set; no other change needed there. §F diagram updated to remove the [OQ-11] tag.                                                                                                                                                                                                                             | `superset_config.py:36`; `bootstrap.py` `guest_role_name = current_app.config.get("GUEST_ROLE_NAME", "Public")`.                                                                                                                                                                                                                                                                             |
| ~~OQ-12~~ | ~~Superset starts by default and binds all interfaces.~~ **Decided 2026-09-11.** §C and §S corrected to reflect current reality (starts by default, binds all interfaces) and the forward-looking requirement (T4/T6 add `profiles: [reporting]` and `127.0.0.1:` loopback bind). The threat model now says "blocked by T4/T6 (phase 0 — not yet implemented)" rather than claiming it is already blocked.                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                            |
| OQ-13     | **The datasets are the raw physical tables, not masked views.** `bootstrap.py` registers `entity_instances` and `workflow_events` directly, with `expose_in_sqllab=True` on the connection. §C says "masked views per ADR-001" and P2 specifically excludes raw `workflow_events` for PII. Does P1-A land before or after any chart is authored?                                                                                                                                                                                                                                                                                        | `bootstrap.py` — `SqlaTable(table_name="entity_instances"...)`, `SqlaTable(table_name="workflow_events"...)`, `Database(..., expose_in_sqllab=True)`.                                                                                                                                                                                                                                        |
| OQ-14     | **There is no tenant-level reporting enablement anywhere.** R8/T18 describe `isReportingEnabled(tenantId)`, a hidden nav item and a "not set up" page. A repo-wide grep for `isReportingEnabled` / `reporting_enabled` / `reportingEnabled` across `.ts`, `.tsx` and `.sql` returns **no matches**. Every authenticated agent/admin in every tenant currently gets the page.                                                                                                                                                                                                                                                            | **Decided 2026-09-09** — no enablement flag will be built. Reporting is always-on for every tenant, matching other tenant-wide features. R8, T18, and the "not enabled" screen states are removed from this spec.                                                                                                                                                                            |
| OQ-15     | **Every Superset secret still has a working default.** `SUPERSET_SECRET_KEY`, `SUPERSET_GUEST_TOKEN_SECRET`, `SUPERSET_SERVICE_ACCOUNT_USER` and `_PASSWORD` all carry usable `.default(...)` values, and `SUPERSET_SITE_URL`/`SUPERSET_INTERNAL_URL` both default to `http://localhost:8088` — which also defeats R14's "must differ in production" check. T5/T22 unstarted. **§S updated 2026-09-11:** the "S" and "E" threat rows no longer claim these secrets are already blocked — they now say "blocked by T5 (phase 0 — not yet implemented; usable defaults exist today)". OQ-15 remains open, tracking T5/T22 implementation. | `packages/config/src/env.ts:225-230`.                                                                                                                                                                                                                                                                                                                                                        |

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
