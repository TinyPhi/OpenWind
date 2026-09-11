# Superset Standalone + Zitadel SSO (Stage 2)

> Superset on its own URL, Zitadel login, reporting on OpenWind data. Stage 2. Stage 1 (embedded) is `superset-embedded-dashboarding.md`.

status: draft
created: 2026-09-08
updated: 2026-09-08
issue: #106

---

## §G Goal

| stage | delivery                                                         | for                                         | status                                          |
| ----- | ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| 1     | embedded in admin-ui `/reporting`, no Superset login             | all roles, tabs gated per role              | `superset-embedded-dashboarding.md` — in review |
| 2     | Superset's own URL, Zitadel login, user writes their own queries | analysts who need to explore, not just view | this doc, blocked on Stage 1 T1/T2              |

Stage 2 is additive. Stage 1 stays the default path.

## §P Challenges

Four real problems. Evidence for each is a command or file, not an assertion.

### P1 — the DB connection bypasses row-level security _(blocker — now owned by Stage 1)_

**Moved to Stage 1 on 2026-09-09.** The options table and the recommendation now live in
`superset-embedded-dashboarding.md` §P1, because the weak layer exists in production as soon as
Stage 1 ships — scheduling the fix here was too late. Stage 2 **depends** on it (Stage 1 T1/T2)
rather than owning it.

Why it is a _harder_ gate here than in Stage 1: Stage 1 users cannot write queries, and every
query carries a filter we attach server-side. A Stage 2 analyst writes their own SQL, so on a
`BYPASSRLS` connection they can read every tenant — and no Superset-side configuration reliably
prevents that.

### P2 — the granted data surface is wider than ADR-001 intends _(also owned by Stage 1)_

Evidence and recommendation: `superset-embedded-dashboarding.md` §P2 (34 tables granted, including
the raw `workflow_events` that migration 0009 excludes for PII). Repaired by Stage 1 T3.

Stage 2-specific consequence: in Stage 1 nobody can query those tables directly; in Stage 2 an
analyst can, so the repair must be in place _and_ verified before this stage opens.

### P3 — role/tenant must come from Zitadel, not from Superset

Superset stores roles on its own user records. If those drift from Zitadel, access outlives the
grant that justified it.

Verified available (checked in the installed library, not assumed —
`flask_appbuilder/security/manager.py`): `AUTH_USER_REGISTRATION`,
`AUTH_USER_REGISTRATION_ROLE`, `AUTH_ROLES_SYNC_AT_LOGIN`, `AUTH_ROLES_MAPPING`,
`OAUTH_PROVIDERS`. Superset's own `AUTH_TYPE` default is `AUTH_DB` (`superset/config.py:313`), so
it must be switched to OAuth explicitly.

Tenant resolution already exists in OpenWind: `lookupTenantIdByOrgId`
(`packages/auth/src/middleware.ts:543`) maps a Zitadel org id to a tenant. Stage 2 reuses it
rather than inventing a second mapping.

**Take:** `AUTH_ROLES_SYNC_AT_LOGIN = True`, registration role grants nothing, refuse a login whose
claims carry no tenant.

### P4 — Superset becomes user-facing

Today it is not hardened for that: port `8088` is published, the admin password defaults to `admin`
(`docker/superset/init.sh:13`), SQL Lab is enabled on the platform DB connection
(`bootstrap.py`, `expose_in_sqllab=True`), and `SUPERSET_SECRET_KEY` /
`SUPERSET_GUEST_TOKEN_SECRET` have working defaults in `packages/config/src/env.ts`.

**Take:** no defaults for secrets (fail startup in production), real hostname + TLS, no default
admin password, and SQL Lab only on a connection that satisfies P1.

### P5 — roles sync at login, so a revoked analyst keeps working until their session ends

`AUTH_ROLES_SYNC_AT_LOGIN` re-evaluates roles **at login only**. A user whose Zitadel role or
tenant is revoked mid-session keeps their Superset session until it expires — and no session
lifetime, idle timeout or logout propagation is specified anywhere.

Stage 1 bounds this to 60s by construction (a short-lived pass, re-minted through our API). Stage 2
has no such bound: it is a real browser session in a second application.

| #   | option                                                                                  | effect                                                                                  |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A   | short max session + idle timeout, and propagate Zitadel single-logout (SLO) to Superset | closest to "revocation is prompt"; SLO wiring is real work                              |
| B   | short session + idle timeout only, no SLO                                               | simple; logging out of OpenWind leaves a live Superset session on another tab or device |
| C   | rely on Superset's defaults                                                             | revocation unbounded in practice                                                        |

**Recommend A**, and state both numbers. R4's "bounded by session lifetime" is meaningless until a
value exists. C is not acceptable for a role that can export data.

## §C Constraints

| constraint    | value                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prerequisite  | P1 resolved — tenant isolation enforced in the DB, not in Superset config                                                                                                                                                                                   |
| identity      | Zitadel OIDC for all humans; Superset-local accounts non-interactive only                                                                                                                                                                                   |
| authorization | role + tenant from Zitadel claims each login; never user-editable, never defaulted                                                                                                                                                                          |
| session       | explicit max duration **and** idle timeout, both stated as numbers; Zitadel single-logout propagated (P5)                                                                                                                                                   |
| step-up auth  | the reporting-analyst role requires MFA at the Zitadel level — a role that runs ad-hoc queries and exports results is what SOC 2 CC6.1 / ISO 27001 A.9.4 expect step-up for. Deferring to "the platform baseline" is itself a decision, so make it explicit |
| data surface  | only what the reporting role is granted; masked views per ADR-001. **Column-level review is part of adding a dataset**, not just tenant scoping — a new dataset can re-expose a column a masked view was built to hide                                      |
| export        | row cap and query timeout bound _query_ cost, not _exfiltration volume_. Repeated exports need their own limit, and the audit record must capture **what** was exported, not only who and when                                                              |
| audit trail   | query and export records ship to the platform's append-only audit store — **not** left in Superset's own logs, which a Superset admin can edit or purge                                                                                                     |
| data at rest  | Superset caches results in Redis and writes exports/thumbnails to its own volume, so tenant data exists outside the masked views (Stage 1 §C) — in scope for retention, erasure and residency                                                               |
| blast radius  | one shared instance: a compromise reaches every tenant, and Superset holds a database credential with a network path to it (Stage 1 §P7). Decided there, not re-decided here                                                                                |
| stage 1       | unaffected; both paths coexist                                                                                                                                                                                                                              |
| out of scope  | write-back to OpenWind, cross-tenant/benchmark reporting, Superset-authored alerts                                                                                                                                                                          |
| compliance    | **open question, not an engineering call:** a DPIA for broadened visibility into cross-record operational data, plus any data-residency constraint on Superset's metadata database, cache and export storage. Owner needed — see §T                         |

### how this follows existing platform patterns

Stage 1's §C carries the full mapping; the additions specific to this stage:

| what we need                             | existing pattern to follow                                                                                                  | precedent                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| tenant resolved from a Zitadel org claim | already implemented and cached — do not add a second mapping                                                                | `packages/auth/src/middleware.ts` — `lookupTenantIdByOrgId` + its TTL cache |
| query/export audit records (R7)          | `writeAuditEntry` from `@platform/audit` into the append-only `admin_audit_log`; Superset's own logs are not an audit trail | `apps/api/src/routes/api-keys/create.ts`; migration 0011                    |
| export rate limiting (R7)                | ADR-013's tier shape, same as Stage 1's mint limit — a per-tenant aggregate tier, not a new bespoke scheme                  | `docs/decisions/ADR-013-unified-rate-limiting-strategy.md`                  |
| abuse-case tests (T17)                   | `*.isolation.test.ts` per surface, asserting zero rows rather than an error                                                 | `apps/api/tests/isolation/`                                                 |

Two requirements have **no** in-repo precedent and are genuinely new ground, so they need a
decision rather than a pattern to copy:

- **MFA for a single role** (§C step-up auth) — the platform has no per-role step-up mechanism
  today; roles come from Zitadel claims and are used for authorization, not for auth strength. This
  is a Zitadel-side policy question, not an OpenWind code change.
- **Single-logout propagation** (P5) — nothing in the platform currently propagates a Zitadel
  logout to a second application. admin-ui has an idle-logout hook (`use-idle-logout.ts`) but that
  is same-app only, so it is a reference for the _idle timeout_ half and not for SLO.

## §I Interfaces

### Zitadel OIDC (Superset side, `superset_config.py`)

```
AUTH_TYPE = AUTH_OAUTH                 # Superset's default is AUTH_DB (config.py:313)
AUTH_USER_REGISTRATION = True          # first login provisions the Superset user
AUTH_USER_REGISTRATION_ROLE = <no-access role>    # never Gamma/Alpha
AUTH_ROLES_SYNC_AT_LOGIN = True        # re-evaluate roles every login
AUTH_ROLES_MAPPING = { <zitadel role>: [<superset role>] }
OAUTH_PROVIDERS = [{ name: "zitadel", ... }]      # issuer/keys/client from env
```

All five keys verified present in the installed `flask_appbuilder/security/manager.py` — not
assumed. `AUTH_ROLES_SYNC_AT_LOGIN` is not optional: without it a role removed in Zitadel keeps
working in Superset until the account is touched.

### claim → role + tenant

```
roles claim (urn:zitadel:iam:org:project:roles)
   holds the reporting-analyst role  -> Superset role granting explore on that tenant's datasets
   otherwise                         -> no-access role (login succeeds, sees nothing)
tenant  <- lookupTenantIdByOrgId(orgId)   # packages/auth/src/middleware.ts:543, already exists
```

Claims carrying no tenant are refused, not defaulted. Tenant is never selectable inside Superset.

### what Stage 2 does not change

`GET /superset/guest-token`, the embedded uuids, the guest role, and the `/reporting` page stay
exactly as Stage 1 specifies. Stage 2 adds a second door; it does not rebuild the first.

Dashboards and tiles are defined in Stage 1's §I and shared — Stage 2 adds exploration on top of
the same datasets, not a second metric set.

## §R Requirements

R1: humans reach Superset only via Zitadel
✓ no local-credential login form is reachable by an end user
✓ the Stage 1 service account cannot be used interactively

R2: a user sees only their own tenant's rows, whatever query they write
✓ arbitrary SQL/exploration cannot return another tenant's rows
✓ a table with no tenant scoping returns **zero rows**, not all rows
✓ holds without depending on Superset-side configuration staying correct

R3: authorization is derived, not asserted
✓ role and tenant re-evaluated from claims at every login
✓ claims with no tenant, or no reporting role, yield an empty no-access session
✓ a user cannot change their own role or tenant inside Superset

R4: revocation is prompt
✓ removing the role in Zitadel removes access at next login, no manual step
✓ max session duration and idle timeout are configured to **stated numbers**, not defaults — roles
re-evaluate at login only, so session length _is_ the revocation window (P5)
✓ logging out of Zitadel ends Superset sessions on other tabs and devices (single-logout)
✓ the residual window is written down for operators, not left implicit

R5: exposed data is deliberate
✓ only granted tables/views reachable; PII/financial columns excluded per ADR-001
✓ a new dataset ships only after **both** its tenant scoping _and_ its column-level sensitivity are
confirmed — tenant scoping alone can still re-expose a masked column
✓ granted datasets and columns are reviewed periodically, not only at first grant

R6: the reporting-analyst role requires step-up authentication
✓ MFA is enforced for that role at the Zitadel level
✓ the requirement is explicit here rather than inherited silently from the platform baseline

R7: exporting is bounded and attributable
✓ repeated/bulk export is rate limited, separately from query cost limits
✓ the audit record captures what was exported — dataset, columns, row count — not only who and when
✓ query and export records land in the platform's append-only audit store, never only in
Superset's own editable logs

R8: opt-in per deployment and per user
✓ a deployment that hasn't enabled it exposes no Superset login
✓ only holders of the reporting role can log in

R9: Stage 1 unaffected
✓ enabling or disabling Stage 2 does not change embedded reporting

## §S Threat Model (STRIDE)

Mandatory per `.claude/rules/security.md`.

| threat | abuse case                                                                          | blocked by                                                                           |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| S      | forged OIDC token, or another tenant's session reused                               | Zitadel signature + issuer/audience; session bound to mapped tenant                  |
| S      | user edits own role in Superset to gain explore rights                              | R3 — roles re-derived each login                                                     |
| T      | analyst edits a shared dashboard others depend on                                   | explore grant ≠ ownership of shared objects                                          |
| R      | analyst exports another team's data untraceably                                     | query/export log keyed to the Zitadel subject, recording **what** was exported       |
| R      | a Superset admin edits or purges the query/export log to hide activity              | audit records ship to the platform's append-only store, not Superset's own logs (§C) |
| E      | an analyst's Zitadel role is revoked but their Superset session keeps working       | P5 — session lifetime, idle timeout and single-logout, all with stated values        |
| S      | a stolen analyst password is used without a second factor                           | §C step-up auth — MFA required for this role                                         |
| I      | bulk or repeated export drains data within an allowed session                       | §C export limits — row caps bound query cost, not exfiltration volume                |
| I      | a newly added dataset re-exposes a column a masked view hid                         | R5 — column-level review is part of adding a dataset                                 |
| I      | tenant rows read from Superset's Redis cache or export volume rather than the views | §C data at rest — both in scope for retention and erasure                            |
| I      | SQL joining a table with no tenant filter                                           | **R2 / P1-A** — the reason Stage 2 is gated                                          |
| I      | selecting a PII column ADR-001 excludes                                             | P2 — not granted to the role                                                         |
| I      | no-role user browses dataset metadata                                               | registration role grants nothing                                                     |
| D      | unbounded query over all history                                                    | row cap, query timeout, separate pool/replica                                        |
| E      | Stage 1 service-account credential used to log in                                   | R1                                                                                   |
| E      | analyst reaches SQL Lab on the `BYPASSRLS` connection                               | P1 — that connection must be gone first                                              |

Carry as acceptance criteria: _tenant A attempts each of the above against tenant B and gets zero
rows — not an error that confirms existence._

## §V Invariants

- reporting tenant isolation is enforced by the database; an unscoped table returns zero rows
- no `BYPASSRLS` role is reachable by an interactive Superset user
- role and tenant derive from Zitadel claims every login; never user-editable, never defaulted
- a newly provisioned Superset user's default role grants nothing
- Stage 1's embedded path never depends on Stage 2 being enabled
- a dataset is not exposed until its tenant scoping is confirmed

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | phase | status                              | depends    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------- | ---------- |
| T1  | _(moved to Stage 1 T1)_ ADR: reporting isolation boundary — **hard prerequisite**, not owned here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 0     | see Stage 1                         | —          |
| T2  | _(moved to Stage 1 T2)_ implement the chosen isolation model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 0     | see Stage 1                         | Stage 1 T1 |
| T3  | _(moved to Stage 1 T15)_ isolation test: unscoped table returns zero rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0     | see Stage 1                         | Stage 1 T2 |
| T4  | _(moved to Stage 1 T3)_ re-assert 0009's grant allowlist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 0     | see Stage 1                         | —          |
| T5  | Zitadel OIDC client + `AUTH_OAUTH` with roles sync at login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 1     | todo                                | T2         |
| T6  | claim→role/tenant mapping via `lookupTenantIdByOrgId`; no-access default; refuse tenant-less                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1     | todo                                | T5         |
| T7  | reporting-analyst role in Zitadel; disable interactive local login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1     | todo                                | T5         |
| T8  | hardening (P4): no secret defaults, TLS + hostname, no default admin password                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1     | todo                                | —          |
| T9  | session max duration + idle timeout with **stated values**; propagate Zitadel single-logout (P5, R4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1     | todo                                | T5         |
| T10 | require MFA for the reporting-analyst role at the Zitadel level (R6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1     | todo                                | T7         |
| T11 | query/export audit trail keyed to the Zitadel subject, recording **what** was exported, shipped to the platform's append-only store (R7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2     | todo                                | T6         |
| T12 | export limits distinct from query limits — bulk/repeated export rate limiting (R7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2     | todo                                | T6         |
| T13 | resource limits: row cap, query timeout, and **revisit the read-replica decision** — Stage 1 deliberately reads the live DB (users can't write queries there); Stage 2 lets analysts run heavy ad-hoc queries against it. If a read-replica is introduced for this workload, the `analytics_user` grant-allowlist repair and its pinning test (Stage 1's T3) must be independently re-applied to the replica before analysts get SQL Lab access to it — PostgreSQL logical replication does not replicate role grants, so a replica created fresh (or copied from the primary's currently-drifted state) would reintroduce the same grant-drift bug found in Stage 1's P2 | 2     | todo                                | T2         |
| T14 | dataset onboarding checklist: tenant scoping **and** column-level sensitivity review; periodic review of granted datasets (R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2     | todo                                | T6         |
| T15 | retention/erasure coverage for Superset's Redis result cache and export volume — tenant data lives outside the masked views. Stage 1 now carries the equivalent baseline task (Redis result-cache TTL configured to the platform's deletion SLA) — see `superset-embedded-dashboarding.md` T25c; this task covers what Stage 2 adds on top (the export volume, and ad-hoc query results specific to exploration)                                                                                                                                                                                                                                                          | 2     | todo                                | T6         |
| T16 | **compliance: DPIA + data-residency question** for Superset's metadata DB, cache and export storage. Not an engineering decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2     | **assign on review — owner needed** | —          |
| T17 | abuse-case tests from §S — cross-tenant attempts return zero rows. Named explicitly, matching Stage 1's T24 "returns zero rows, not an error" criterion: (1) a query written to deliberately dodge tenant filtering must return zero rows, not an error or exception that would confirm the query's shape was valid; (2) a request with a tampered/forged OIDC claim must be rejected outright at the OIDC layer, before ever reaching Superset; (3) an analyst's export must be both correctly row-bounded by their tenant scope AND correctly attributed to the right tenant in the audit trail                                                                         | 2     | todo                                | T6         |

phase gate: **phase 0 is hard.** No SSO wiring until an unscoped table provably returns zero rows
on the reporting connection. Wiring SSO first creates exactly the exposure P1 describes.

## Open Questions

For the reviewer. Stage 1's own open questions (isolation option, backup shape, blast radius,
capacity, CVE cadence) are in that doc and are **prerequisites** to this one — OQ-1 there gates
everything here.

| ID   | Question                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Should the reporting-analyst role require MFA, and is that enforced in Zitadel rather than by us?             | **No precedent in the repo** — the platform has no per-role step-up today; Zitadel roles drive _authorization_, not auth strength. So this is a Zitadel policy decision, not an OpenWind code change. Raised because a role that can run ad-hoc queries and export results is what SOC 2 CC6.1 / ISO 27001 A.9.4 expect step-up for, and silence would read as "no".                                                                                    |
| OQ-2 | Is single-logout in scope for v1, or is a short session + idle timeout enough?                                | **No precedent in the repo** — nothing currently propagates a Zitadel logout to a second application. `apps/admin-ui/src/hooks/use-idle-logout.ts` is same-app only, so it is a reference for the _idle timeout_ half and **not** for SLO. Consequence if deferred: logging out of OpenWind leaves a live Superset session on another tab or device until it expires. This makes R4's "revocation is prompt" partly new engineering, not configuration. |
| OQ-3 | What are the actual numbers for max session duration and idle timeout?                                        | P5. Roles re-evaluate at login only, so session length _is_ the revocation window. R4 cannot be verified until values exist.                                                                                                                                                                                                                                                                                                                            |
| OQ-4 | Who owns the DPIA and the data-residency question?                                                            | Superset's metadata database, its Redis result cache and its export volume all hold tenant data outside the masked views. Not an engineering decision — flagged rather than left silent (T16).                                                                                                                                                                                                                                                          |
| OQ-5 | Is content-aware export auditing plus an export-specific rate limit the right scope, or is more DLP expected? | R7. Row caps and query timeouts bound _query_ cost, not exfiltration volume via repeated exports.                                                                                                                                                                                                                                                                                                                                                       |

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
