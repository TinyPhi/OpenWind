# ADR-019: Reporting Tenant Isolation — Embedded and Standalone Superset

**Status:** Accepted (2026-11-02, repo owner). Stage 2 stays disabled (`SUPERSET_OAUTH_CLIENT_ID`
unset) on every deployment until the Stage 2 gate criteria below are signed off. Accepting this ADR
does not mean the gate is met: whether each criterion is met is tracked in the issues it names and
in the sign-off record. The Stage 2 security review (OQ-6) closed on 2026-09-30; its outcome is
recorded in Decisions 2 and 6.  
**Date:** 2026-09-28.  
**Deciders:** Engineering Lead (isolation approach owned by Bikash, decided 2026-09-09).  
**Related to:** ADR-001 (multitenancy — RLS, `analytics_user` grants), ADR-013 (rate limiting),
ADR-015 (observability + compliance — retention, erasure), issue #106 (3G tracker), issue #695.  
**Amended:** 2026-11-02, Stage 2 gate criteria section rewritten (#1076); owner decisions on the
gate recorded, criterion 9 names `SUPERSET_DEPLOYMENT`, status changed from Proposed to Accepted.  
**Supersedes:** —  
**Superseded by:** —

---

## Context

### Problem — A shared BI tool has no notion of a tenant

Track 3G gives every tenant MIS reporting through Apache Superset: fixed dashboards embedded in
admin-ui (Stage 1), and a standalone Superset where analysts sign in with Zitadel and write their
own SQL (Stage 2). One Superset instance and one reporting database connection serve every
tenant.

The platform's isolation is Postgres row-level security keyed on a per-connection setting: every
policy is `tenant_id = current_setting('app.tenant_id', true)::uuid`, and the API sets it per
request (ADR-001). Superset does not. A shared reporting connection with no setting sees either
nothing or everything, depending on the role it connects as. Stage 2 makes this worse: once a
user writes the query, every table the role can read is reachable, so nothing about the boundary
can depend on which SQL Superset happens to generate.

This ADR records the isolation design. Stages 1–2 are already merged (#663–#671, migrations
0112–0124), so like ADR-016/ADR-017 it ratifies shipped behaviour rather than gating new work.

### What this boundary must stop

- A tenant reading another tenant's rows, through a chart, a native filter, or hand-written SQL.
- A non-staff user reading tickets inside their own tenant that are not theirs.
- Reporting reaching payload columns that can hold PII or financial values
  (`workflow_events.metadata`, `entity_instances.fields`, `tenant_users.email`).
- A forged, edited or replayed embed pass selecting a tenant of the caller's choosing.
- An audit record written by the reporting role that claims to come from another tenant.
- A misconfiguration (a missing tenant, a dataset nobody added a filter to) failing open.

### What already exists that this ADR builds on

- Platform RLS on every tenant-scoped table, keyed on `app.tenant_id` (ADR-001, ADR-007)
- `analytics_user`, the read-only reporting role, with a default-deny grant convention and the
  per-table access policy in ADR-001
- `admin_audit_log` — append-only, tenant-scoped, closed action vocabulary
- Zitadel as the identity provider, with org → tenant mapping

---

## Decision

### Decision 1 — Superset as the reporting engine, embedded first, standalone second

Superset (pinned at 6.1.0) is the BI engine. Stage 1 exposes fixed, provisioned dashboards only;
it opens no query-writing surface. Stage 2 (standalone + Zitadel SSO) needs the stronger data
boundary in Decisions 2–6; whether that boundary holds against user-written SQL was the subject of
the Stage 2 security review (OQ-6), now closed; see Decision 2.

**Not chosen:** Metabase. Its free tier embeds static dashboards only; per-tenant filtered
embedding is a paid feature.

### Decision 2 — Isolation is the platform's own RLS, stamped per connection

Superset's `DB_CONNECTION_MUTATOR` (`docker/superset/superset_config.py`) stamps the caller's
tenant onto each reporting connection as a libpq startup option (`-c app.tenant_id=<uuid>`). The
platform's existing RLS policies then apply to Superset exactly as they apply to the API. There is
no second isolation mechanism to keep in sync with the first.

The tenant comes from, in order: the guest-pass username the API mints (embedded), the verified
guest token on the request (dashboard-level queries Superset runs as the owner), and the user's
`tenant:<uuid>` role bound at login (Stage 2). The value must match `_TENANT_ID_RE` (in
`docker/superset/superset_config.py`, read by `DB_CONNECTION_MUTATOR`; an anchored
`^…$` 8-4-4-4-12 hex UUID pattern) before it reaches the connection string; that regex is the
whole defence against injecting further startup options. Subject ids used for own-rows scoping
match the anchored `_PRINCIPAL_ID_RE` in the same file.

Two properties this relies on, both verified against the image's source. They cover the chart and
embedded paths; for Stage 2 SQL Lab they are not enough on their own (see the binding signature
below):

1. **No connection is reused across tenants.** Superset uses `NullPool` by default — a fresh
   physical connection per query, closed after.
2. **`analytics_user` cannot bypass RLS.** Migration 0112 sets `NOBYPASSRLS`, and reporting
   views are `security_invoker`, so the caller's privileges and policies apply through them.

**Binding signature (Stage 2 review outcome, GHSA-28jx-36cp-g34h).** The stamped settings alone
are not enough, because a SQL Lab session can change them with `SET`. Each reporting session also
carries `app.reporting_binding_sig`, an HMAC-SHA256 over tenant, scope and user id, keyed by
`REPORTING_BINDING_SECRET`. The database verifies it through `reporting_bound_tenant()` (migration
0128), and a restrictive policy on every table `analytics_user` can read requires a verified
tenant. A changed setting no longer matches its signature, so the session sees no rows. With
Stage 2 on, Superset's chart-data cache is off (`NullCache`), because its cache key has no tenant
in it. Fix: `1047f03`.

**Not chosen:**

- **A database credential per tenant.** Correct, but N credentials to provision, rotate and
  register in Superset, for no isolation gain over one role plus RLS.
- **Superset's own row-level security rules.** Superset attaches rules per table, so a table
  nobody attached a rule to returns every tenant's rows. The boundary would be a config row, and
  the database would not catch the mistake.

### Decision 3 — Fail closed, with no fallback tenant

If no tenant can be resolved, the mutator stamps nothing. `current_setting('app.tenant_id', true)`
returns NULL, every policy evaluates false, and the query returns zero rows. The failure mode is an
empty dashboard, never another tenant's data. There is deliberately no default value.

### Decision 4 — The guest-token row filter is a second layer, not the boundary

The API mints each embed pass with a tenant clause on every dataset and, for the per-user
dashboard, a per-user clause scoped to each dataset. The mint is refused if any dataset on the
dashboard lacks filter coverage. Ids are regex-allowlisted before interpolation, because a row
filter has no parameterised form.

This filter is defence in depth. Decision 2 holds even if a filter is missing or wrong.

### Decision 5 — Reporting reads only what it is granted; payloads are excluded, not redacted

- **Tables:** migration 0113 revokes everything and re-grants only the tables provisioned
  datasets read. `tenants` is excluded (no RLS, so `SELECT *` would return every tenant); org →
  tenant goes through `tenant_for_org()` (0114), a `SECURITY DEFINER` function with a pinned
  `search_path`. `SELECT` on `pg_stat_statements` is revoked from `PUBLIC`.
- **Columns:** payload columns are never granted — `workflow_events.metadata` (0118),
  `tenant_users.email` (0120), `entity_instances.fields` / `search_vector` / `origin_*` (0122).
  What charts need comes from trigger-maintained mirrors: `event_type` (0117),
  `reporting_title` / `reporting_department` (0121), `reporting_priority` (0123).
- **Shape:** Superset applies a row filter by rewriting a table to `SELECT * FROM <table> WHERE …`,
  which column grants cannot satisfy. `reporting_instances` (0124) is a `security_invoker` view
  holding only the safe columns, so `SELECT *` on it is harmless.

The per-table list lives in ADR-001 ("Per-table access policy") and is not duplicated here. A
column added to a granted table in future is unreadable by reporting until someone grants it
deliberately.

**This supersedes the masked-read choice recorded on 2026-09-14 (option C: redact on write into a
stored column).** It was replaced on 2026-09-21 by `docs/specs/reporting-metadata-masking-repair.md`,
because a redacting view has to read the column it hides; under `security_invoker` that meant an
analyst could use it only while also holding the raw column. Exclusion is the stronger control:
the column is not reachable at all.

**Not chosen:** granting the raw payload and controlling access by role membership (substitutes
configuration discipline for a technical control); a redacting view running with its owner's
privileges (the own-rows policy in Decision 6 would silently stop applying); a stored generated
column (rewrites the table under an exclusive lock on PostgreSQL 16).

### Decision 6 — "My work only" is a database rule

Non-staff users are narrowed to their own tickets by a `RESTRICTIVE` policy on `entity_instances`
and `workflow_events` (0116), scoped to `analytics_user` alone and keyed on
`app.reporting_scope = 'own'` plus `app.reporting_user_id`. Restrictive, so it ANDs with the tenant
policy instead of offering another way in. The mutator stamps these for any non-staff Stage 2
session. If a session's own-rows binding is unusable — more than one `owuser:` role, or a subject
that fails `_PRINCIPAL_ID_RE` — it is stamped with `app.reporting_user_id=-`, a subject no ticket
can have, so the session sees nothing rather than falling back to tenant-wide
(the own-rows branch of `DB_CONNECTION_MUTATOR` in `superset_config.py`). Scope and user id are
covered by the same binding signature as the tenant (Decision 2), so a session cannot widen its
own rows by changing them.

When the scope setting is absent the policy is tenant-wide; the embedded path and staff
(`admin`, `agent`, `superadmin`) rely on that. On the embedded path a customer asking for the
tenant dashboard is refused with 403, and the per-user dashboard carries its own clause
(Decision 4).

### Decision 7 — Reporting audit goes into the platform's audit log, bound to the session tenant

Query and export events are written to `admin_audit_log` through `record_reporting_audit()` (0115),
a `SECURITY DEFINER` function with a fixed action allowlist (`reporting.query_executed`,
`reporting.exported`). It refuses a connection with no tenant, refuses a tenant parameter that
disagrees with the session, and writes the session tenant — never the caller's parameter.

The API records `reporting.guest_token_issued` / `reporting.guest_token_denied` for every embed
pass through the normal audit writer.

**Not chosen:** granting `INSERT` on the audit table (would let the role write records attributed
to anyone); relying on Superset's own action log (a Superset admin can edit or purge it, and it
sits outside the platform's retention and export guarantees).

**Shipped gap (verified 2026-09-28 on a running 6.1.0 instance):** the Superset side of this
decision does not fire. `PlatformAuditEventLogger` maps the action names `sql_json`, `sqllab_viz`,
`csv`, `export_csv` and `csv_endpoint`, but Superset 6.1.0 logs `SqlLabRestApi.get_results`,
`ChartDataRestApi.data` and `SqlLabRestApi.export_streaming_csv` for the same operations. A SQL Lab
query, a streaming CSV export and a chart CSV export by a `ReportingAnalyst` wrote no
`reporting.*` row. The database function is correct; the mapping in `superset_config.py` is stale.
The API's guest-token audit is unaffected. Tracked in #709.

**Audit is best-effort.** Both the guest-token audit write and the Superset-side write are
fail-open: if the audit store is unreachable, the pass is still minted and the query still runs.
The Stage 2 actor is the Zitadel login name rather than always the subject id (standalone spec
T11). Refusing queries when the audit store is unreachable is deferred (see Deferred Decisions).

### Decision 8 — Embed passes are short-lived, least-privileged and instance-bound

- Lifetime 60 s (`GUEST_TOKEN_JWT_EXP_SECONDS`); the API refuses a minted pass that lives longer
  than 90 s. A pass cannot be revoked mid-life, so this value is the revocation window.
- Guests get a dedicated `EmbeddedViewer` role, not `Public` (Public is Flask-AppBuilder's
  anonymous role).
- Audience is left at Superset's default, which binds a pass to the instance that issued it.
- Dashboards are addressed by slug; no Superset-generated id is stored in the platform.

### Decision 9 — Standalone identity comes from Zitadel, never from the user

Stage 2 is off unless `SUPERSET_OAUTH_CLIENT_ID` is set. Users sign in through Zitadel; roles are
re-synced at every login; a new user lands in `ReportingNoAccess`. The tenant is resolved at login from
the org claim through `tenant_for_org()`; the sign-in flow offers no way to choose it. SQL Lab is read-only on the
reporting database (`allow_dml`, `allow_ctas`, `allow_cvas` all off).

---

## Consequences

### Positive

- One isolation mechanism for API and reporting. A fix or test on platform RLS covers both.
- Every misconfiguration found so far fails closed (empty result or refused mint), not open.
- New tables and new columns are unreadable by reporting by default.
- Reporting audit is designed to share the platform's retention, export and erasure guarantees
  (not yet effective for Superset-side events — see Decision 7's shipped gap).

### Negative and mitigations

- **Stage 2 must stay disabled until the gate is signed off.** Mitigation: Stage 2 is off unless
  `SUPERSET_OAUTH_CLIENT_ID` is set; no deployment sets it until the gate criteria below are met.
  Stage 1 remains the production path.
- **`REPORTING_BINDING_SECRET` is required for all reporting, Stage 1 included.** Without it,
  dashboards are empty (fail closed) and production migrations refuse to run.
- **The per-connection stamp relies on a direct connection with no pooling.** Superset connects
  to Postgres directly, not through PgBouncer (PgBouncer is configured for `app_user` only).
  Routing reporting through the pinned PgBouncer fails closed either way: checked 2026-09-28
  against the pinned `edoburu/pgbouncer` image (PgBouncer 1.25.2), a client sending
  `options=-c app.tenant_id=<uuid>` is refused at login (`FATAL: unsupported startup parameter in
options`), and adding the parameter to `ignore_startup_parameters` would drop it silently, so
  every query would return zero rows. Mitigation: pooled reporting needs a different way to carry
  the tenant, which is a new decision, not a PgBouncer setting (see Deferred Decisions).
- **Bootstrap window.** `docker/postgres/init/001_setup.sql` still creates `analytics_user` with
  `BYPASSRLS` and a default `SELECT` grant; migrations `0112`/`0113` undo both. Migrations run in
  the separate `bootstrap` profile, so compose `depends_on` cannot order them. Mitigation:
  tracked in #708.
- **Views must stay `security_invoker`.** Base tables are owned by `migration_user` (`BYPASSRLS`)
  and no reporting table uses `FORCE ROW LEVEL SECURITY`, so a reporting view without
  `security_invoker = true` would silently drop tenant isolation. Mitigation: the isolation suite
  asserts it for `reporting_instances`
  (`apps/api/tests/isolation/reporting-grants.isolation.test.ts`); any future reporting view needs
  the same test.
- **The connection mutator has no test.** Nothing under `docker/superset/` tests
  `DB_CONNECTION_MUTATOR`; the isolation tests set the settings directly, and behaviour when the
  mutator raises has not been verified. Mitigation: none yet.
- **One shared Superset instance is a single blast radius.** A Superset compromise reaches the
  reporting connection for every tenant. Mitigation: accepted for single-node compose; pinned
  image, production refuses empty or dev-default secrets (#666), network restriction deferred
  until the deployment leaves single-node.
- **Tenant data also lives outside the database.** Superset's Redis result cache (300 s TTL), its
  metadata DB and export files hold tenant data. Mitigation: the cache TTL bounds how long a
  purged tenant's rows survive; retention and backup coverage are open (see Open Questions).
- **Mirror columns must be kept in step with their source.** Mitigation: they are trigger-
  maintained and backfilled in the same migration that adds them.
- **Column grants plus `SELECT *` rewriting broke 23 of 35 charts once (0122 → 0124).**
  The failing statement was only reproduced by replaying Superset's generated SQL verbatim; checks
  that spelled columns out all passed. Mitigation: `reporting_instances` (0124); a new dataset
  should be checked against the SQL Superset actually emits, not a hand-written query.
- **Stage 2 export is available before its limits exist.** Export is an intended Stage 2
  capability — the standalone spec's R7 requires it to be bounded and attributable, not withheld.
  Verified 2026-09-28: a `ReportingAnalyst` downloads chart CSV through `can_csv` and SQL Lab
  streaming CSV through `can_read` on SQLLab (the endpoint declares `@permission_name("read")`);
  only the plain SQL Lab export (`can_export_csv`) is withheld. Exports are bounded by the same
  scoping as queries (Decisions 2 and 6). Mitigation: Stage 2 stays disabled until the gate is
  signed off, and export-specific rate limiting (standalone T12) is pending.
  Unlike the audit gap in Decision 7, this is accepted rather than a defect.
- **A 60 s pass cannot be revoked.** Mitigation: the lifetime is the revocation window by design
  and is enforced on both sides.

---

## Deferred Decisions

| Deferred item                                           | Trigger to revisit                                      | Why deferred                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Routing reporting through PgBouncer                     | 200-concurrent load target (spec T17) or pooler change  | The pinned PgBouncer refuses the startup option; needs a new way to carry the tenant |
| Refusing queries when the audit store is unreachable    | Compliance owner requires fail-closed audit             | Audit is best-effort today (Decision 7)                                              |
| Network restriction around Superset                     | Deployment moves off single-node compose                | Blast radius accepted in writing for now                                             |
| Read replica for reporting                              | Reporting load affects the primary                      | Grants must be re-applied on any replica; logical replication does not copy grants   |
| Export-specific limits in Stage 2                       | Stage 2 becomes a production path (standalone T12)      | Export is allowed; row caps bound query cost, not bulk-export volume                 |
| Per-tenant on/off switch for reporting                  | Tenant asks to disable reporting                        | Reporting is always on, tabs gated per role (decided 2026-09-09)                     |
| Service-account session cache and a mint-specific limit | Mint latency or abuse observed; 200-dashboard load test | Only the global rate limit (ADR-013) applies to the mint endpoint today              |

---

## Open Questions

| ID   | Question                                                                                                             | Notes                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | ~~Is CSV download reachable in Stage 2 even though `can_export_csv` is deliberately withheld?~~ **Resolved: yes.**   | Verified 2026-09-28 on a running 6.1.0 instance: chart CSV (`can_csv`) and SQL Lab streaming CSV (`can_read` on SQLLab) return 200; plain SQL Lab export returns 403. Export is an intended capability (spec R7); see Negative and mitigations. |
| OQ-2 | Should the free-text `workflow_events.comment` column, which stays granted, get its own treatment?                   | Kept on purpose for charts; open in `reporting-metadata-masking-repair.md` OQ-1.                                                                                                                                                                |
| OQ-3 | Is Superset (metadata DB, result cache, export volume) covered by backups and by ADR-015's retention/erasure sweeps? | `scripts/backup.sh` does not mention Superset today. ADR-015's sweeps are Postgres row-level; the Redis result cache (300 s TTL) is not swept, so erasure cannot be declared complete until it expires.                                         |
| OQ-4 | Should roles be re-checked when a pass is minted, rather than only at sign-in?                                       | Known gap; bounded by the 60 s pass lifetime.                                                                                                                                                                                                   |
| OQ-5 | Single-logout and MFA for Stage 2 sessions?                                                                          | Session lifetime is capped (480 min); single-logout and MFA are open in `superset-standalone-with-zitadel.md`.                                                                                                                                  |
| OQ-6 | ~~Does the Stage 2 boundary (Decisions 2 and 6) hold against user-written SQL?~~ **Resolved 2026-09-30.**            | The private review closed with advisory GHSA-28jx-36cp-g34h; the fix (`1047f03`) adds the binding signature recorded in Decisions 2 and 6. The separate SQL Lab 0-row bug (#716) was fixed in #798 (2026-10-07).                                |

---

## Stage 2 gate criteria (2026-11)

Stage 2 (Superset OAuth SSO, per-user Superset accounts) must not be enabled in a deployment until
every criterion below is met, the evidence for each is linked in the sign-off record, and the gate
owner has signed. This section records the gate; it does not enable anything. Stage 1 (embedded
dashboards, no per-user accounts) is not gated by it. It replaces the shorter three-item list that
stood here before 2026-11 (#1076).

**Gate owner: PrabhuVijit** (named 2026-10-19). The owner confirms each criterion and decides when
Stage 2 is enabled. **Deadline:** _set by the owner_.
**Sign-off record:** one comment on #728 (or a file under `docs/tracker/`; owner's choice) with one
line per criterion: its evidence link, who checked it, and the date. A criterion without a link is
not met. Whether a criterion is met today is tracked in the issues it names and in the sign-off
record, not in this ADR.

Criteria marked (H) need a named human decision or an operational action and cannot be satisfied by
code. The others are satisfied by an artefact in the repository or in CI.

**Owner decisions (confirmed by the owner (2026-11-02)).** The hard gates stand as drafted: #1139
(criteria 11-14: redact SQL literals, pseudonymise the actor, the 90-day cap, the purge test), #1081
(criterion 18: rate limiting on the erasure endpoints) and the reverse-proxy rule (criterion 17,
H6). Name and email correction sync (#1075) is not required for Stage 2. The values stand as drafted:
a 30-day erasure target with a day-7 pending alert (criterion 8), 90 days of reporting audit
retention by default (criterion 14), 24 hours of failed-job subject retention in Redis (criterion 15) and 10 requests per minute on the erasure endpoints (criterion 18).

**Prerequisite (owner action): a production-configured environment.** Criterion 21 needs an
environment that runs the production configuration (production compose file, OpenBao-delivered
secrets, Zitadel, Superset with Stage 2 on) but is not the production deployment. No such
environment exists today. Owner decision (confirmed by the owner (2026-11-02)): the owner will
create a production-configured environment before sign-off; owner and target date: `TBD: not
decided`. If the owner later declines to create one, this section must be amended before sign-off to say that the real
run happens in production immediately after enabling, with the rollback in criterion 22.

### A. Isolation and tests

1. **Security review (OQ-6).** Closed 2026-09-30 (GHSA-28jx-36cp-g34h, fix `1047f03`), recorded in
   Decisions 2 and 6. _Evidence:_ this ADR.
2. **Connection guard.** The `NullPool` startup assertion and its CI check pass (#729, #795-#797).
   _Evidence:_ CI job `superset-guard` green.
3. **Cross-tenant abuse tests (ST17) run in CI.** All cases of `docker/superset/test_abuse_st17.py`,
   including the real-database cases (T6, T7), run on every change under `docker/superset/**` and on
   every Superset image bump, and **a skipped test fails the job**. A signed-in user cannot reach
   another tenant's rows; a forged login is refused; tenant-filter-dodging SQL returns nothing; an
   export is audited against the right tenant; neither a username nor a guest pass changes the stamped
   tenant. _Evidence:_ the CI job (#1143) green on the commit that enables Stage 2, plus a run with the
   database variables removed that fails (shows skip-is-failure). The tests exist (#1074); running
   them in CI is #1143.
4. **Erasure, audit and SQL Lab tests run in CI.** `test_erasure_endpoint.py`,
   `test_erasure_realdb.py` (including the foreign-key coverage guard that fails the build when a new
   `ab_user` reference appears), `test_audit_mapping.py`, `test_audit_scope.py`, `test_audit_realdb.py`,
   `test_sqllab_identity.py`, `test_sqllab_count_realdb.py` and `test_secret_checks.py` run in the same
   way, with the same skip rule. _Evidence:_ same CI job(s) (#1143).
5. **Audit rows exist.** SQL Lab queries and exports write `reporting.*` rows to `admin_audit_log`
   under Superset 6.1.0's action names (#709, #799) and SQL Lab returns the tenant's rows (#716, #798).
   _Evidence:_ criterion 4's CI run covers both.

### B. Erasure runs, completes and can be shown to have completed

6. **Erasure is queued automatically.** After a user erase and after a tenant purge, the Superset
   metadata-database erasure and the result-cache flush are queued without an operator, retried for at
   least 24 hours, and end in a `superset_erasure.completed` or `.failed` audit row. _Evidence:_
   `apps/worker/src/superset-erasure.test.ts`, `apps/worker/src/tenant-purge.test.ts`; metric
   `openwind_superset_erasure_total{outcome}` (#1031, #1071, #1100, #1101).
7. **Durable queueing.** A committed user erase that was not queued (queue down, API restart between
   commit and enqueue) is re-queued by a reconciler within 15 minutes. The reconciler reads across
   tenants only through a narrow database role (not `app_user`, not BYPASSRLS), is idempotent through
   the deterministic job id, and does not sweep erases made before Stage 2 was enabled.
   _Evidence:_ a test that fails the enqueue after commit and asserts the job appears; an isolation
   test (one tenant's rows never cause an action for another); a fresh-database test that migrates as
   the real `migration_user` and runs the reconciler as the real roles (#1138).
8. **Erasure completion target and alert.** The target is 30 days from the request to a
   `superset_erasure.completed` row, written in `docs/runbooks/superset-erasure.md`. A requested
   erasure (user erase or tenant purge row) with no `completed` row after 7 days raises a warning
   alert that names the tenant and a subject hash, never the raw subject, and clears when the row
   appears. _Evidence:_ promtool test cases in `docker/observability/alert.rules.test.yml` (run in
   CI). Builds on criterion 7 (#1141).
9. **Enablement consistency.** Deployments that run Superset set an explicit deployment setting on
   the API and the worker: `SUPERSET_DEPLOYMENT=off|on` (default `off`; it replaces
   `SUPERSET_ERASURE_ENABLED`, which is now ignored). `SUPERSET_OAUTH_CLIENT_ID` then only
   distinguishes Stage 2 from Stage 1. A repeatable worker self-check (every 15 minutes and at
   startup) compares Superset's own report of whether Stage 2 is on with the local mode, runs a no-op
   smoke erase against a synthetic tenant, and alerts on any mismatch, failed smoke erase or missing
   self-check. With Stage 2 on in Superset and local config disagreeing, the API and tenant purge treat
   the mode as "full", or return an `unverified` status (warning tone in the admin UI, an audit row)
   and never say "Superset holds no account for this user". _Evidence:_ worker self-check tests, API
   erasure-queue tests, promtool cases, and a Superset-side test of the status route (#1137).
10. **Production wiring is complete.** The production compose file and runbook list every secret and
    setting Stage 2 needs on every service that needs it (client id and secret on `superset` and
    `superset-init`; client id on `backend` and `worker`; `SUPERSET_SERVICE_ACCOUNT_PASSWORD` on
    `worker`, required at startup; the deployment setting of criterion 9), and
    `scripts/setup-superset-oauth.ts` prints that checklist. _Evidence:_ the production compose check
    in `packages/openbao-deploy` (`check-prod-compose.test.ts`) in CI; the runbook section (#1142,
    #1137).

### C. Personal data in the audit trail

11. **Typed SQL is redacted before it is written.** String and numeric literals are removed from SQL
    text before a `reporting.*` audit row is written (structure, table names and a statement hash
    stay). Applied in Superset's audit mapping. _Evidence:_ unit tests on representative statements
    (literals, comments, quoted identifiers); `test_audit_mapping.py` and `test_audit_realdb.py` still
    green (#1139).
12. **The actor is pseudonymised on erase.** After a user erase, no `reporting.*` row carries that
    user's readable id. The platform does not rely on GDPR Art. 17(3)(b) for these rows: security
    logging under legitimate interest is not a legal obligation. _Evidence:_ test after a user erase
    asserting no readable id in `admin_audit_log` `reporting.*` rows for that tenant (#1139).
13. **Tenant purge removes or anonymises audit SQL.** _Evidence:_ test asserting that after a tenant
    purge no audit row of that tenant keeps SQL text (#1139).
14. **Reporting audit rows have a retention cap, as a setting.** A sweep removes `reporting.*` rows
    older than the cap, through a narrow role (same pattern as `access_log_retention_role`, migration
    0158); the cap is configurable with a default of 90 days. _Evidence:_ sweep test with the real
    roles; the setting in `@platform/config` (#1139).
15. **Failed-job subject retention is bounded.** Failed Superset erasure jobs keep `{kind, tenantId,
subject}` in Redis for at most a documented, short period (default, confirmed by the owner
    (2026-11-02): 24 hours after the
    retry window, or the subject hashed), not the current 7 days. _Evidence:_ test on
    `apps/worker/src/superset-erasure-options.ts`; runbook line (#1140, item 1).
16. **User-removal paths are enumerated.** Every code path that removes a user (platform admin,
    sandbox delete or handover, org-directory sync, per-user erase, tenant purge) either calls the
    Superset erasure or has a recorded reason it cannot leave an account behind. _Evidence:_ the list
    in the runbook (#1140, item 4).

### D. Exposure

17. **Erasure endpoints are not reachable from outside the Docker network.** The reverse-proxy rule
    blocking `/openwind/erasure/*` exists in the deployment's own configuration and is proven by a
    recorded request from outside that is refused. (H) _Evidence:_ the rule text and the recorded
    request in the sign-off record. The repository holds no such rule.
18. **Erasure endpoints are rate-limited.** A per-caller limit on `_erasure_blueprint()` routes
    (10 requests per minute, confirmed by the owner (2026-11-02)). _Evidence:_ test in `test_abuse_st17.py` or
    `test_erasure_endpoint.py` (#1081, which says it should be in place before Stage 2 goes live).

### E. Decisions only a human can make (H)

19. **Legal basis and retention are recorded.** A named person (acting DPO or counsel) has recorded:
    the legal basis for logging typed SQL and access (legitimate interest assessment, not Art.
    17(3)(b)), the retention value for criterion 14, whether the DPDP security-log floor applies
    (spec D4), and who is data fiduciary and who is processor for this deployment (D7). Engineering
    does not choose the number. If the owner accepts an interim state instead, that acceptance, with
    its date and an expiry, is the record. (`docs/specs/superset-gdpr-erasure.md` D4, D6, D7.)
20. **Breach owner is named.** `docs/runbooks/breach-notification.md` names the incident commander,
    the security intake contact and the legal reviewer for this deployment, with no `TBD` in those three
    rows, because Stage 2 adds a store of personal data (Superset accounts, typed SQL) and a
    72-hour clock (#639).

### F. Recorded real run, then enablement

21. **Recorded real run.** In an environment with the production configuration (see the prerequisite
    above), with Stage 2 on: the self-check is green; a test user signs in through SSO and runs one
    SQL Lab query whose audit row has no literal; an admin erases that user from the users page; a
    `superset_erasure.completed` row appears; the user's `ab_user` row is anonymised; and the user's
    readable id is absent from the audit rows. Then a test tenant is purged and its audit rows keep no
    SQL text. A production stack with Stage 2 still off does not count. (H) _Evidence:_ the run log
    attached to the sign-off record.
22. **Enablement, in this order.** (1) Deploy with the deployment setting of criterion 9 set to `on`
    on the API and worker and Stage 2 still off; the self-check is `ok` with Stage 1 confirmed. (2)
    Apply the proxy rule (criterion 17). (3) Store `SUPERSET_OAUTH_CLIENT_ID` and
    `SUPERSET_OAUTH_CLIENT_SECRET` in OpenBao at the `superset` and `superset-init` paths and
    `SUPERSET_OAUTH_CLIENT_ID` at the `backend` and `worker` paths (ADR-023);
    `SUPERSET_SERVICE_ACCOUNT_PASSWORD` is already required at the `worker` path. Locally,
    `.env.local`. (4) Restart all four services. (5) Wait one self-check interval and confirm the
    config-mismatch gauge is 0 and no alert is firing. (6) Repeat the erase of criterion 21 with one
    test user in production (the post-enable verification). (7) Announce. **Rollback:** remove the id
    from the four paths and restart; accounts created meanwhile stay in Superset's database and must
    be erased by hand (runbook) because the platform then reports Stage 1. (H)

### Not required for Stage 2

These are known, owned and recorded in the sign-off record as accepted. They do not block the gate:
name and email correction sync (#1075); cache-flush coalescing race (bounded by the 300 s TTL; with
Stage 2 on the data cache is a NullCache); accounts held for a person who is also a member of another
tenant (reported, decided by a human, by design); tenantless accounts, which only per-user erase
reaches; Superset process-log retention and the absence of persistent export files, which are
confirmed on a running instance and recorded in the runbook (#1140 items 2-3) but are not code gates;
Superset metadata-database backups, deliberately not taken (spec D5); single logout and MFA for
Stage 2 sessions (OQ-5); re-checking roles when a pass is minted (OQ-4); Zitadel instance-wide
deletion; test renames (#1082); a nightly compose-based smoke job; a real Zitadel login end-to-end
test (covered by criterion 21); Stage 3.

### Related ADR edits when the gate is signed

Mark OQ-3 resolved: "user erase and tenant purge remove the user's data from Superset's metadata DB
and flush its result cache, automatically, retried until done, reconciled if not queued, and audited
(#728). Superset's metadata DB is deliberately not backed up (spec D5)." Correct the "Tenant data also lives
outside the database" bullet in Negative and mitigations, which lists "export files", if #1140 item 3 confirms none persist. Remove "Stage 2 stays
off pending review" in the client-onboarding table when enabled.

---

## Implementation next steps

1. No implementation is gated on this ADR: Stages 1–2 are merged (#663–#671, migrations 0112–0124).
2. ~~Correct ADR-001's database-user table.~~ Done in #702: ADR-001 now lists `analytics_user` as
   "Column-scoped SELECT, subject to RLS | Superset reporting (see ADR-019)".
3. ~~#709: correct the `PlatformAuditEventLogger` action mapping to
   Superset 6.1.0's action names, with a test that a real query and a real export each write a
   `reporting.*` row.~~ Done in #799.
4. ~~Close OQ-6: once the private Stage 2 review closes, record its outcome in Decisions 2 and 6 and
   lift the Stage 2 note in Status.~~ Done, see OQ-6.
5. Update the standalone spec's status line, which says export is "deliberately ungranted pending
   T12": chart CSV and SQL Lab streaming export are available; only T12's limits are pending.
6. Reconcile the stale option-C wording in `docs/specs/superset-embedded-dashboarding.md` (§V, T3,
   T3b, T3c, T12) with Decision 5.
