# ADR-019: Reporting Tenant Isolation — Embedded and Standalone Superset

**Status:** Proposed. Stage 2 is pending a security review, tracked privately (OQ-6): Stage 2 must
stay disabled (`SUPERSET_OAUTH_CLIENT_ID` unset) on every deployment until that review closes and
this ADR records the outcome.  
**Date:** 2026-09-28.  
**Deciders:** Engineering Lead (isolation approach owned by Bikash, decided 2026-09-09).  
**Related to:** ADR-001 (multitenancy — RLS, `analytics_user` grants), ADR-013 (rate limiting),
ADR-015 (observability + compliance — retention, erasure), issue #106 (3G tracker), issue #695.  
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
boundary in Decisions 2–6; whether that boundary holds against user-written SQL is the subject of
the pending review (OQ-6).

**Not chosen:** Metabase. Its free tier embeds static dashboards only; per-tenant filtered
embedding is a paid feature.

### Decision 2 — Isolation is the platform's own RLS, stamped per connection

Superset's `DB_CONNECTION_MUTATOR` (`docker/superset/superset_config.py`) stamps the caller's
tenant onto each reporting connection as a libpq startup option (`-c app.tenant_id=<uuid>`). The
platform's existing RLS policies then apply to Superset exactly as they apply to the API. There is
no second isolation mechanism to keep in sync with the first.

The tenant comes from, in order: the guest-pass username the API mints (embedded), the verified
guest token on the request (dashboard-level queries Superset runs as the owner), and the user's
`tenant:<uuid>` role bound at login (Stage 2). The value must match `_TENANT_ID_RE` (`docker/superset/superset_config.py:128`, an anchored
`^…$` 8-4-4-4-12 hex UUID pattern) before it reaches the connection string; that regex is the
whole defence against injecting further startup options. Subject ids used for own-rows scoping
match the anchored `_PRINCIPAL_ID_RE` (`:126`).

Two properties this relies on, both verified against the image's source. They cover the chart and
embedded paths; for Stage 2 SQL Lab the outcome is recorded after the pending review (OQ-6):

1. **No connection is reused across tenants.** Superset uses `NullPool` by default — a fresh
   physical connection per query, closed after.
2. **`analytics_user` cannot bypass RLS.** Migration 0112 sets `NOBYPASSRLS`, and reporting
   views are `security_invoker`, so the caller's privileges and policies apply through them.

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
(`superset_config.py:195`, `:300`). As with Decision 2, the Stage 2 outcome is recorded after the
pending review (OQ-6).

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

- **Stage 2 is pending a security review and must stay disabled.** The review is tracked
  privately (OQ-6). Mitigation: Stage 2 is off unless `SUPERSET_OAUTH_CLIENT_ID` is set; no
  deployment sets it until the review closes. Stage 1 remains the production path.
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
  scoping as queries (Decisions 2 and 6). Mitigation: Stage 2 stays disabled pending OQ-6, and
  export-specific rate limiting (standalone T12) is pending.
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
| OQ-6 | Does the Stage 2 boundary (Decisions 2 and 6) hold against user-written SQL?                                         | Pending a security review, tracked privately. Stage 2 stays disabled until it closes; Decisions 2 and 6 then record the outcome. SQL Lab returns no rows for Stage 2 users (#716); Stage 1 is unaffected.                                       |

---

## Implementation next steps

1. No implementation is gated on this ADR: Stages 1–2 are merged (#663–#671, migrations 0112–0124).
2. ~~Correct ADR-001's database-user table.~~ Done in #702: ADR-001 now lists `analytics_user` as
   "Column-scoped SELECT, subject to RLS | Superset reporting (see ADR-019)".
3. #709: correct the `PlatformAuditEventLogger` action mapping to
   Superset 6.1.0's action names, with a test that a real query and a real export each write a
   `reporting.*` row (standalone spec T11 is marked done but writes nothing today).
4. Close OQ-6: once the private Stage 2 review closes, record its outcome in Decisions 2 and 6 and
   lift the Stage 2 note in Status.
5. Update the standalone spec's status line, which says export is "deliberately ungranted pending
   T12": chart CSV and SQL Lab streaming export are available; only T12's limits are pending.
6. Reconcile the stale option-C wording in `docs/specs/superset-embedded-dashboarding.md` (§V, T3,
   T3b, T3c, T12) with Decision 5.
