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
- a tenant with reporting switched off has no Reporting nav item
- Superset unavailable → a readable message on that page only

## §D Decisions

**D1 — Apache Superset.** Metabase's free tier does static embeds only; per-tenant filtered
interactive embedding is a paid feature. Superset covers it in the OSS tier, consistent with the
self-hosted stack (decided 2026-08-19, issue #106).

**D2 — embedded first, standalone second.** Stage 1 gives everyone fixed dashboards with no new
attack surface. Stage 2 opens query-writing and needs a stronger data boundary, so it is staged
after. Embedded matches `architecture-brief.md` §8.11 and `platform-vision.md` ("no direct DB
access from UI").

**D3 — deployment configures Superset; tenants only switch it on.** Connection details are env
vars via `@platform/config` (`.env.local` locally — note `.env` is tracked in git — and the same
names at deploy time). There is no store for user-entered credentials, so **one Superset instance
per deployment**; tenants are separated by the row filter on each request, not by separate
instances. The Connectors screen is a status + on/off surface, never a credentials form.

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

| #   | option                                                                                                   | fails closed?                                                                                                                    | cost                                  |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A   | Superset reads **tenant-scoped views only**, via a role with no `BYPASSRLS` and no grants on base tables | yes — an unfiltered query returns nothing                                                                                        | one view per exposed table            |
| B   | per-tenant database credential; ordinary RLS applies                                                     | yes                                                                                                                              | N credentials to provision and rotate |
| C   | keep the current role, rely on Superset's own filter rules                                               | **no** — Superset attaches rules per table (`get_rls_filters`), so a table nobody attached a rule to returns every tenant's rows | lowest                                |

**Recommend A.** It is the only option where a mistake yields _no data_ instead of _everyone's
data_. The honest snag — and why this is an ADR, not a task — is that Superset shares one
connection across users, so A works by making the views themselves incapable of returning
cross-tenant rows rather than by per-session state. C is the trap: the boundary would be a config
row and the database would not catch the error.

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

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BI engine        | Apache Superset `4.0.2`, digest-pinned like every other third-party image; `superset` and `superset-init` move in lockstep. **Pinning requires a re-pin cadence** — a tracked CVE check against the pinned digest, aligned with how `CLAUDE.md`'s maintenance notes handle npm overrides |
| transport        | `SUPERSET_INTERNAL_URL` carries the service-account login, CSRF token and session cookie. Plain HTTP is acceptable **only** while that hop stays inside a single host's docker network; any topology where it crosses a network segment requires TLS                                     |
| secrets          | no usable defaults, and a written rotation procedure. Rotating `SUPERSET_GUEST_TOKEN_SECRET` invalidates live embeds (acceptable at 60s); rotating `SUPERSET_SECRET_KEY` also invalidates Superset's own sessions, so the mint path must retry once on 401                               |
| admin account    | the Superset admin password is mandatory, generated not chosen, and stored the same way every other platform credential is — never in the image, never a default                                                                                                                         |
| data at rest     | Superset caches query results in Redis and may write exports/thumbnails to its own volume, so **tenant data exists outside the masked views**; both are in scope for retention and erasure questions                                                                                     |
| backup           | Superset's metadata database holds every dashboard, chart, user and role. `scripts/backup.sh` dumps only the `platform` database today, so it must be extended — the YAML export covers dashboards but not users or roles                                                                |
| frame protection | admin-ui sends `Content-Security-Policy: frame-ancestors 'self'`; the embed iframe keeps the sdk's sandbox no wider than the handshake needs                                                                                                                                             |
| embedding        | `@superset-ui/embedded-sdk` — the sdk owns the iframe and its handshake; never a hand-rolled `<iframe src>`                                                                                                                                                                              |
| auth (users)     | Zitadel only; no user-facing Superset auth of any kind                                                                                                                                                                                                                                   |
| auth (machine)   | one least-privilege Superset service account, backend-only, able to mint embed passes and nothing else                                                                                                                                                                                   |
| config           | env vars via `@platform/config`; no secrets in the database, none user-entered                                                                                                                                                                                                           |
| tenancy          | row filter attached server-side at request time; never a client param, never UI-only                                                                                                                                                                                                     |
| DB access        | live database, read-only, **no replica** — acceptable in Stage 1 because users cannot write queries; Stage 2 revisits it                                                                                                                                                                 |
| data surface     | only tables the reporting role is granted; masked views per ADR-001; **no tile reads `fields` JSONB**                                                                                                                                                                                    |
| dashboards       | exactly 2, fixed identifiers seeded by provisioning; no picker                                                                                                                                                                                                                           |
| deployment       | Superset is an **opt-in compose profile** — a plain `docker compose up` does not start it                                                                                                                                                                                                |
| deferred         | Celery worker/beat (async chart loading); sync-only for Stage 1 per #102                                                                                                                                                                                                                 |
| out of scope     | chart authoring, user-written SQL, scheduled/emailed reports, drill-through into Records, our own date picker, dashboard picker                                                                                                                                                          |

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
| audit entries for views and enable/disable (R5)                         | `writeAuditEntry` from `@platform/audit`, called inside the same transaction as the action                                                                         | `apps/api/src/routes/api-keys/create.ts`                                                                                                                      |
| `frame-ancestors` response header (R14)                                 | a small dedicated middleware registered in `createApp()`, alongside the existing transport-security one                                                            | `apps/api/src/middleware/https-enforcement.ts`                                                                                                                |
| isolation tests (T24)                                                   | one `*.isolation.test.ts` per surface under the api app's isolation suite                                                                                          | `apps/api/tests/isolation/` — e.g. `api-key-auth.isolation.test.ts`                                                                                           |
| digest pin + a written upgrade discipline                               | the dependency-override notes: each pin carries the reason it exists so nobody silently drops it                                                                   | `CLAUDE.md` "Maintenance notes"                                                                                                                               |

One place with **no** precedent to follow, so it needs a decision rather than a copy:
`scripts/backup.sh` dumps a single database (`POSTGRES_BACKUP_DB`, default `platform`). There is no
multi-database backup pattern in the repo — the `zitadel` metadata database is not covered either.
So R12 either extends that script to loop over a list, or accepts a second invocation; whichever is
chosen should cover `zitadel` at the same time rather than solving it once for Superset.

## §I Interfaces

### Part 1 — what the user sees

### navigation and access

| surface      | value                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| nav item     | **Reporting**, in the sidebar after Analytics                                 |
| route        | `/reporting`                                                                  |
| visible when | the tenant has reporting enabled; hidden otherwise                            |
| roles        | all roles — admin/agent get both tabs, customers get My Performance only (D4) |

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

Scope is **involved** — assigned to me **or** created by me **or** granted/mentioned — matching the
platform's single existing definition of "my work". Not assigned-only, so the numbers agree with
the personal dashboard elsewhere in the product.

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

| state                                | what the user sees                                                      |
| ------------------------------------ | ----------------------------------------------------------------------- |
| normal                               | tabs + populated charts                                                 |
| loading                              | skeleton placeholder in the panel, not a blank box                      |
| reporting not enabled for the tenant | no nav item; direct URL shows "Reporting is not set up"                 |
| Superset unavailable                 | "Reporting is not available right now" + a retry action                 |
| SLA not configured                   | the SLA tiles show "configure SLAs to enable" (P4)                      |
| workflow has no states               | that tile shows "not configured" — never a zero that reads as real data |
| user involved in nothing             | My Performance shows an explicit empty state                            |

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

1. User opens `/reporting`. The page checks the tenant has reporting enabled and the user's role.
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
→ 404 reporting not enabled for this tenant
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

## §R Requirements

R1: reporting is reachable without any Superset-facing login
✓ no Superset login screen, prompt or credential is ever shown to a user
✓ the user's Zitadel session is the only login involved

R2: a user sees their own tenant's data and no other tenant's
✓ the pass carries a tenant filter, attached server-side before the iframe loads
✓ a pass minted for tenant A cannot be replayed to view tenant B
✓ a dataset that no filter covers causes the request to be **refused**, not served unfiltered

R3: the per-user tab scopes to work the caller is involved in
✓ assigned **or** created **or** granted — the platform's existing predicate, not a second one
✓ its figures reconcile with the personal dashboard elsewhere in the product
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

R6: provisioning is automatic and idempotent
✓ both dashboards are registered embeddable; identifiers are stable across re-runs
✓ embedding is permitted from the deployment's own origin and nothing wider
✓ guest permissions land on a dedicated role, never the anonymous one

R7: failure degrades to a readable message
✓ Superset unreachable, mint failure and not-enabled each render a plain message
✓ no internal detail (host, status, service-account identity) reaches the browser
✓ a placeholder shows while loading; a retry is offered on failure
✓ failure is contained to this page

R8: enablement is respected immediately
✓ not enabled → no nav item; direct URL shows "not set up", never a 5xx
✓ a cross-tenant or absent connector row returns 404, not 403

R9: revocation is prompt
✓ pass lifetime is 60s, bounding the window after any disable
✓ the mint path re-checks tenant-active and connector-enabled on every refresh

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

| threat | abuse case                                                                                                                                                                    | blocked by                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S      | forge a pass offline using a default signing secret                                                                                                                           | no usable secret defaults; startup fails in production (§C)                                  |
| S      | replay tenant A's pass from an attacker's page                                                                                                                                | embed-origin allowlist; 60s lifetime. Passes carry no origin binding — accepted risk, stated |
| T      | a tenant admin's enable action rewrites shared Superset settings                                                                                                              | provisioning must not mutate shared settings after first run                                 |
| R      | a user views another team's figures untraceably                                                                                                                               | R5 audit log                                                                                 |
| I      | a chart on an uncovered dataset returns every tenant's rows, HTTP 200, no error                                                                                               | R2/R5 refusal + P1-A                                                                         |
| I      | raw `workflow_events` exposes PII metadata                                                                                                                                    | P2 grant repair + the pinning test                                                           |
| I      | anyone on the network reaches Superset and uses SQL Lab as `admin`                                                                                                            | P3                                                                                           |
| D      | mint flood — each mint is three Superset calls including a password hash                                                                                                      | rate limit per tenant, citing ADR-013's tiers                                                |
| D      | **normal traffic** self-DoSes the instance: ~200 logins/min at 200 open dashboards                                                                                            | P6-A session caching + a stated, load-tested capacity figure                                 |
| E      | the service-account credential leaks and grants SQL Lab over every tenant                                                                                                     | least-privilege service account (§C)                                                         |
| E      | a forged Superset admin session via a known signing key → RCE (the CVE-2023-27524 mechanism; our 4.0.2 is unaffected by the CVE itself, but the shipped default recreates it) | no usable secret defaults; startup fails on a production default                             |
| E      | Superset is compromised and reaches the database directly over the docker network, holding its own credential                                                                 | P7 — accepted in writing today; network restriction when this leaves single-node compose     |
| I      | tenant rows sit in Superset's Redis result cache and its own volume, outside the masked views                                                                                 | §C data-at-rest; retention and erasure must cover both                                       |
| I      | admin-ui is framed by a hostile page to relay a pass within its 60s window                                                                                                    | `frame-ancestors 'self'` + a minimal iframe sandbox (§C)                                     |
| I      | the mint hop's session cookie is observed on an unencrypted internal network segment                                                                                          | §C transport — TLS required whenever that hop leaves a single host                           |

Carried as criteria: _tenant A attempts each of the above against tenant B and gets zero rows — not
an error that confirms existence._

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
- the per-user tab uses the platform's single definition of "my work"
- per-person figures appear only on that person's own tab
- tiles are exported to the repo; the Superset volume is never the only copy

## §T Tasks

### phase 0 — settle the boundary and close the surface

| id  | task                                                                                                                                | owner                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T1  | **ADR: reporting tenant-isolation boundary** — choose P1 A/B/C. Human-authored (agents may not write ADRs); blocks phase 2 entirely | **assign on review — this spec cannot be approved without an owner and a date on this row** |
| T2  | implement the chosen isolation model                                                                                                | TBD                                                                                         |
| T3  | re-assert migration 0009's grant allowlist + a test pinning the granted table set (P2)                                              | TBD                                                                                         |
| T4  | loopback bind, mandatory admin password, SQL Lab off (P3)                                                                           | TBD                                                                                         |
| T5  | remove usable secret defaults; fail startup on a production default (closes the CVE-2023-27524 attack class, P7)                    | TBD                                                                                         |
| T6  | opt-in compose profile; digest-pin the images **and record a re-pin/CVE-check cadence**                                             | TBD                                                                                         |
| T7  | mandatory generated admin password, stored like every other platform credential                                                     | TBD                                                                                         |
| T8  | add the `superset` metadata database to `scripts/backup.sh`; document a restore (R12)                                               | TBD                                                                                         |
| T9  | `frame-ancestors 'self'` on admin-ui; minimal embed-iframe sandbox (R14)                                                            | TBD                                                                                         |
| T10 | accept the P7 blast radius in writing, or add the network restriction                                                               | **assign on review**                                                                        |

### phase 1 — the mechanism

| id  | task                                                                                                                                                             | depends |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| T11 | Superset service, own metadata database, cache index, config                                                                                                     | T4,T6   |
| T12 | provisioning: data connection, two dashboards, embeddability, dedicated guest role                                                                               | T2,T11  |
| T13 | `GET /superset/guest-token` — service-account login → CSRF(+cookie) → filtered pass                                                                              | T12     |
| T14 | **cache the service-account session** with single-flight refresh and retry-once-on-401 (P6-A, R11)                                                               | T13     |
| T15 | dataset-scoped filters, resolved by name, with **coverage refusal** (R5)                                                                                         | T13     |
| T16 | 60s pass lifetime + rate limit (R9)                                                                                                                              | T13     |
| T17 | state and load-test a supported concurrent-dashboard figure (R11)                                                                                                | T14     |
| T18 | `isReportingEnabled(tenantId)`; nav and page honour it (R8)                                                                                                      | —       |
| T19 | admin-ui page: two tabs (one for customers), sdk mount, role scoping, loading and failure states (R7)                                                            | T15,T18 |
| T20 | audit-log entries for views and for enable/disable (R5)                                                                                                          | T18     |
| T21 | key-rotation procedure for both Superset keys, with blast radius stated (R13)                                                                                    | T14     |
| T22 | validate `SUPERSET_SITE_URL` ≠ `SUPERSET_INTERNAL_URL` in production (R14)                                                                                       | —       |
| T23 | TLS on the API→Superset hop wherever it leaves a single host (R14)                                                                                               | —       |
| T24 | isolation tests: cross-tenant replay, disabled tenant, uncovered-dataset refusal, unscoped read returns zero rows, customer refused the tenant dashboard         | T15     |
| T25 | e2e test for the route — mandatory for `apps/api`. Fixtures use **real issued id shapes** (Zitadel numeric subject, `apikey:<uuid>`), never invented look-alikes | T15     |

### phase 2 — the views

| id  | task                                                                                | depends |
| --- | ----------------------------------------------------------------------------------- | ------- |
| T26 | seed demo data — no tile is signed off against 3 records (P5)                       | —       |
| T27 | Tenant Overview tiles                                                               | T15,T26 |
| T28 | My Performance tiles on the involved predicate                                      | T15,T26 |
| T29 | empty / not-configured states for every tile (R10)                                  | T27,T28 |
| T30 | export dashboards, charts and datasets to YAML in-repo + documented re-import (R12) | T27,T28 |
| T31 | connector status/enable surface + Connectors card                                   | T18     |
| T32 | SLA tiles, once `sla_hours` is configurable and set (P4)                            | T27     |

phase gate: phase 0 completes before phase 1. T1/T2 gate the tiles — building views on a boundary
that is about to change is wasted work. Every phase must pass
`typecheck` + `lint` + `test` + `test:isolation`.

## Open Questions

For the reviewer. Each of these is a decision this spec deliberately does **not** make — either
because it is above an engineering call, or because the repo has no existing pattern to copy and
inventing one unreviewed is how the last round of mistakes happened.

| ID   | Question                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Which isolation option do we take — A (tenant-scoped views on a non-bypass role), B (per-tenant DB credential), or C (Superset's own rules)? Who owns the ADR, and by when?       | §P1. Recommendation is **A**; C is a trap because an unattached table returns every tenant's rows. This gates every tile — phase 2 cannot start without it. Needs a name and a date on T1.                                                                                                                                                        |
| OQ-2 | Do we extend `scripts/backup.sh` to cover multiple databases, or accept a second invocation for Superset's metadata?                                                              | **No precedent in the repo** — the script dumps one database (`POSTGRES_BACKUP_DB`, default `platform`), and there is no multi-database backup pattern to copy. Note the `zitadel` metadata database is **also** not backed up today, so whichever shape is chosen should cover it in the same change rather than solving this only for Superset. |
| OQ-3 | Is "one Superset instance per deployment, so a compromise reaches every tenant" an accepted risk in writing, or does it need a network-layer restriction alongside the SQL grant? | §P7. Verified: the Superset container reaches `postgres:5432` directly, so loopback-binding the browser port does not reduce what Superset itself can reach. Recommendation is to accept it explicitly now and revisit when this leaves single-node compose.                                                                                      |
| OQ-4 | What concurrent-dashboard count must Stage 1 support, and who load-tests it?                                                                                                      | R11. A 60s pass lifetime means a refresh per open dashboard roughly every 55s. Session caching (P6-A) removes the per-pass login, but the number still needs stating rather than assuming.                                                                                                                                                        |
| OQ-5 | Who owns the Superset CVE watch and the re-pin cadence?                                                                                                                           | Digest-pinning without a re-pin process freezes today's exposure. The repo's dependency-override notes in `CLAUDE.md` are the closest discipline to align with.                                                                                                                                                                                   |

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
