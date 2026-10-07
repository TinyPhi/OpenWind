# Superset reporting — Stage 2 gate: erase Superset's personal data (#728) and close the open gate issues

> Stage 2 (Superset SSO, `SUPERSET_OAUTH_CLIENT_ID`) stays off until each blocker named in ADR-019
> is closed with proof. This spec builds #728 (erase a user's or tenant's personal data from
> Superset's own DB and cache) and traces every other open gate issue (#709, #716, #729, #731 and
> the cross-tenant abuse tests, ST17) to a task, so none is forgotten.

status: draft — D1–D3 and D8 decided by the owner on 2026-10-07; D5 decided the same day (Superset's database stays out of backups); D4, D6, D7 are open questions for Legal / DPO (§Q)
created: 2026-10-06
updated: 2026-10-07

Task breakdown: [superset-gdpr-erasure-tasks.md](superset-gdpr-erasure-tasks.md).

---

## §G Goal

1. **#728:** erasing a user, or purging a tenant, also removes their personal data from Superset's
   metadata DB and Redis cache; the step is durable, never blocks the Postgres erasure, and a guard
   fails when a Superset table gains an unclassified user reference.
2. **#709, #716, #729:** the fixes already written locally are proven by committed tests that match
   each issue's acceptance criteria.
3. **Cross-tenant abuse tests (the standalone spec's item T17, called ST17 here)** exist and pass.
4. **#731:** the ADR-019 "Stage 2 gate criteria" text is drafted for a human to apply.

## §S0 What this spec deliberately does **not** do

An earlier draft added GDPR-article features that no issue asked for and that DPDP does not require.
They are out of scope here, each with where it goes:

| removed from the draft                                      | why                                                                                       | where it goes                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| restriction endpoint (GDPR Art. 18)                         | no DPDP equivalent; no issue asks for it                                                  | not planned                            |
| Art. 20 portability, read-only access report (Art. 15)      | DPDP s.11 gives a right to a summary, not an export; platform-wide, not Superset-specific | separate issue if privacy asks         |
| erasure ledger + restore reconciliation                     | platform-wide gap that predates Stage 2; needs a store a restore cannot roll back         | separate spec and issue                |
| legal-hold schema                                           | a documented process is enough; no code                                                   | runbook note only                      |
| two-stage retention job, audit SQL scrub, `backup.sh` prune | **blocked on counsel**: DPDP Rules may require keeping security logs for a year (D4)      | decided first (D4), built only after   |
| GDPR article-by-article table                               | wrong law                                                                                 | replaced by the short DPDP table in §D |

## §T0 Traceability: every open issue → what closes it

| issue / source                   | what it asks (acceptance)                                                                                                                     | how it is closed here                                                                                                                                                                                                                                                                                                                          | state today                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **#729**                         | import-time NullPool assertion in `superset_config.py`; CI job runs the check; ADR-019 references it                                          | assertion done. **Deviation:** the issue's `SQLALCHEMY_POOL_CLASS` does not exist in Superset 6.1.0 (verified), so the guard checks the real source instead. CI job = patch for a human (H4); ADR text = H5                                                                                                                                    | merged (#790); the CI job and the ADR-019 text are human tasks |
| **#709**                         | map 6.1.0 action names; **a test where a real SQL Lab query and a real export each write one `reporting.*` row**; correct standalone spec T11 | mapping done, and the chart-CSV request-format fix (the button was not audited at all until 2026-10-06; found live). The product has no SQL Lab download, so the export is the chart CSV button. Still to do: committed real-run test (T3), correct T11 in the standalone spec (T10), and actor = Zitadel subject as T11 itself requires (T12) | in review (#799)                                               |
| **#716**                         | SQL Lab returns the tenant's rows (same count as a chart); retest after the GHSA 0128 fix                                                     | fix and the committed count test (`test_sqllab_count_realdb.py`: SQL Lab, chart and database counts match) merged in #798                                                                                                                                                                                                                      | merged (#798)                                                  |
| **#728**                         | evict cache + erase Superset DB rows on user erasure; update ADR-019 OQ-3                                                                     | §R R1–R9, tasks T13–T26. **Deviation:** cache keys are opaque hashes, not tenant-namespaced (verified), so the cache is flushed by prefix; the platform has no Superset DB access, so Superset erases its own data                                                                                                                             | not built                                                      |
| **#731**                         | ADR-019 "Stage 2 gate criteria": owner, criteria, enablement steps, deadline                                                                  | draft text for the human (T27, H5). The issue's step "via OpenBao" is changed to environment variables (this project does not use OpenBao)                                                                                                                                                                                                     | not drafted                                                    |
| **ST17 (standalone spec's T17)** | forged OIDC claim rejected; tenant-filter-dodging query returns 0 rows; export attributed to the right tenant                                 | abuse tests T5–T8 (ST17), including the UUID-username collision I suspected                                                                                                                                                                                                                                                                    | not written                                                    |
| found while testing              | SQL Lab streaming CSV export returns an empty file in Stage 2                                                                                 | **Dropped 2026-10-07:** the product has no SQL Lab download (owner). The audit mapping still covers the export routes in case a role change ever opens them (T11, H7 closed)                                                                                                                                                                   | closed                                                         |

## §F Findings (verified 2026-10-06; local Superset 6.1.0, repo at `998e5c9`)

- F1: Superset keeps its own DB, separate from `platform`. Platform erasure never touches it.
  `ab_user` has **67** foreign keys: 51 author pointers (`created_by_fk` etc.) and 16 user-owned or
  link columns (classified in §I). `logs.json`, `query.sql` and `tab_state` hold typed SQL.
- F2: Redis result cache: db 2, prefixes `superset_` and `superset_data_`; keys are opaque hashes, not
  tenant- or user-namespaced; TTL 300 s. With SSO on, `DATA_CACHE_CONFIG` is `NullCache`.
- F3: identity. `ab_user` has no subject column. The Zitadel subject exists only as the `owuser:<subject>`
  role, and only for non-staff. Tenant = the `tenant:<uuid>` role. Embedded guests are not persisted.
- F4: the per-user erase route erases in one transaction, then logs (only) a Zitadel failure. The tenant
  purge worker has the durable pattern: BullMQ job, retries, `purge.failed` audit, post-commit work.
- F5: `backup.sh` dumps `platform` + files only; Redis is documented "rebuildable, not backed up".
- F6: the service account is `ReportingServiceAccount`, not `Admin`; it already mints guest tokens.
- F7: `ow-backend` and `ow-worker` already receive `SUPERSET_OAUTH_CLIENT_ID` via `.env.local`.
- F8: Flask-AppBuilder does not refresh an existing user's name or email at login (verified).
- F9: `SQLALCHEMY_POOL_CLASS` does not exist in Superset 6.1.0's config; pooling is controlled by the
  `nullpool` argument of `Database.get_sqla_engine()` (default `True`).
- F10: Stage 2 is off by default; no production Superset users exist yet.

## §C Constraints

| constraint                    | value                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| where Superset data is erased | **inside Superset**, which already reaches its own DB and Redis. The platform only asks. No Superset DB credential goes to the API or worker.   |
| match key                     | the `owsub:<subject>` role added at every login **and** the `tenant:<uuid>` role must match the request. Never username, email or display name. |
| payloads and logs             | ids only. No name, email or SQL in a job, log line, response or audit metadata written by this feature.                                         |
| Superset DB shape             | rows wholly the user's are deleted; `ab_user` is anonymised (51 author-pointer columns reference it).                                           |
| delivery process              | spec → `/spec-tasks` → human `approve-plan` before any edit under `apps/`, `packages/`, `modules/` (`agent-behaviour.md`).                      |
| never autonomous              | `.github/workflows/` and ADR edits. CI jobs are proposed as patches; ADR-019 is updated by a human.                                             |

## §D Decisions

| id  | decision                                                                                                                                                                                                                                                                                                                       | state                           | note                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Erase via a Superset-side endpoint using the **existing** service account. No new secret.                                                                                                                                                                                                                                      | **decided** — owner, 2026-10-07 | F6. Upgrade path: a dedicated account if its scope widens.                                                                                                                                   |
| D2  | Add `owsub:<subject>` to every login (staff included). No backfill.                                                                                                                                                                                                                                                            | **decided** — owner, 2026-10-07 | F3, F10.                                                                                                                                                                                     |
| D3  | API/worker detect Stage 2 through the existing `SUPERSET_OAUTH_CLIENT_ID`, as an optional `@platform/config` field.                                                                                                                                                                                                            | **decided** — owner, 2026-10-07 | F7.                                                                                                                                                                                          |
| D4  | How long Superset and audit-log records (typed SQL, access logs) are kept, and whether SQL text stays in audit rows.                                                                                                                                                                                                           | **OPEN — Legal / DPO**          | Nothing is built or changed until decided. The existing 90-day audit sweep is unchanged. Stage 2 is off, so no SQL is collected meanwhile. See §Q.                                           |
| D5  | The Superset DB is **not** added to `backup.sh`; the docs say why and what is lost: provisioned dashboards, charts and datasets are rebuilt from `tiles.yaml`, user-authored saved queries and charts are not and are lost on a restore. No backup holds an erased user's Superset data, so nothing is re-run after a restore. | **decided** — owner, 2026-10-07 | F5: treated like Redis and Novu's Mongo (rebuildable). **Supersedes** `superset-embedded-dashboarding.md` R12/T8, which says to back the Superset DB up; that spec needs a human edit (H10). |
| D6  | Name, date and reference of whoever approves D4. The legal guidance received so far is unsigned, undated and written in GDPR terms.                                                                                                                                                                                            | **OPEN — Legal / DPO**          | It is input to counsel's DPDP review, not a decision. See §Q.                                                                                                                                |
| D7  | Who is the data fiduciary and who is the processor for a deployment. Retention periods are **settings with defaults**, not fixed in code.                                                                                                                                                                                      | **OPEN — Legal / DPO**          | OpenWind is multi-tenant; the answer differs per deployment. See §Q.                                                                                                                         |
| D8  | How a deployment with **no Superset** is told not to enqueue the cache-only job (it would fail and retry forever). Proposal: an optional `SUPERSET_ERASURE_ENABLED` setting, default on when `SUPERSET_INTERNAL_URL` is reachable at startup.                                                                                  | **decided** — owner, 2026-10-07 | Needed because Stage 1 deployments run the reporting profile optionally.                                                                                                                     |

## §Q Open questions for Legal / DPO

These are legal decisions, not engineering ones. They are carried as open questions in this PR and
nothing that depends on them is built until they are answered. The legal guidance received so far is
unsigned, undated and written in GDPR terms; it is input to the answers, not an answer.

| id  | question                                                                               | owner       | blocks                                                           |
| --- | -------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| D4  | How long should Superset data, typed SQL and audit records be retained?                | Legal / DPO | the retention work, which is out of scope here (§S0)             |
| D6  | Who approves the retention decision (name, date, reference)?                           | Legal / DPO | recording D4 as decided                                          |
| D7  | Who is the legal data controller (fiduciary) and who is the processor, per deployment? | Legal / DPO | the retention defaults, which are settings and not fixed in code |

The erasure of Superset's metadata DB and cache (#728) does not wait on these: it removes a user's
data on request. These questions decide how long the rest is kept when nobody has asked.

## §I Interfaces

**Superset side (new, in `docker/superset/superset_config.py`):**

- `POST /openwind/erasure/user` `{tenantId, subject}` and `POST /openwind/erasure/tenant` `{tenantId}`.
  Authenticated as the service account through its normal login token; any other caller, including
  `Admin`, gets 403; no token gets 401. Returns counts only: `{matchedUsers, deletedRows, cacheKeysRemoved}`.
- Login (`auth_user_oauth`): adds `owsub:<subject>`; refreshes an existing user's first name, last name
  and email from the claims (R9).
- Exported maps `ERASURE_HANDLED` and `ERASURE_EXEMPT` (`table.column` → class / reason) for the guard.

**Classification of `ab_user` references (confirmed by a human before T14 builds on it):**

| class                   | columns                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delete` (owned data)   | `logs.user_id`, `query.user_id`, `saved_query.user_id`, `tab_state.user_id`, `favstar.user_id`, `user_attribute.user_id`, `user_favorite_tag.user_id`, `database_user_oauth2_tokens.user_id`, `task_subscribers.user_id`, `tasks.user_id` |
| `delete` (links)        | `ab_user_role.user_id`, `ab_user_group.user_id`, `dashboard_user.user_id`, `slice_user.user_id`, `sqlatable_user.user_id`, `report_schedule_user.user_id` (an object may lose its last owner; accepted)                                   |
| `author_pointer` (keep) | the 51 `created_by_fk` / `changed_by_fk` / `last_saved_by_fk` columns: they point at the anonymised `ab_user`, so they name no one                                                                                                        |

**Platform side:**

- Queue `superset-erasure` (worker). Job `{kind: "user"|"tenant"|"cache", tenantId, subject?}`, deterministic job
  id. Enqueued by `DELETE /users/:userId` **after** the Postgres commit and by the tenant purge worker
  after the DB purge. Exponential back-off, attempts spanning at least 24 h.
- Audit actions `superset_erasure.completed` / `.failed` (final attempt, `actorType: "system"`, counts
  only). Needs a migration extending `audit_log_action_check` (as 0115 did) and the exhaustiveness maps in
  `packages/audit`.
- Metrics and alerts: a failed job; an erasure request with no `completed` row after 7 days (an
  operational default, a setting, not a legal deadline).

**What "erase" does in Superset:** find users holding `owsub:<subject>` and `tenant:<tenantId>` (refuse
`admin` and the service account) → delete the `delete`-class rows in bounded batches → delete the user's
`owsub:`/`owuser:` roles → anonymise `ab_user` → remove every Redis key under `superset_` and
`superset_data_` in Superset's Redis db (prefix scan + unlink; other tenants pay a few cold loads).

## §R Requirements

R1: Per-user erasure removes the user's personal data from Superset (#728).
✓ a test seeds a user with a row in every `delete` class plus cache keys, calls the real route, then
finds no row naming them, an anonymised `ab_user`, and no key under the Superset prefixes.
✓ other users and other tenants' rows are untouched.

R2: Tenant purge removes every Superset user of that tenant.
✓ real purge function, two tenants seeded; only the purged tenant's users are erased.

R3: Matching never trusts a name.
✓ a username equal to another tenant's id or another user's login name is not matched; right subject
with wrong tenant role is not matched; `admin` and the service account are never erased.

R4: A Superset failure never blocks the Postgres erasure and is never silent.
✓ Superset unreachable: the route still succeeds, Postgres rows are gone, the job is queued.
✓ final failure writes exactly one `superset_erasure.failed` row; success writes `completed`.
✓ no name, email or SQL in the payload, logs or audit metadata. An erasure with no `completed` row after
7 days raises an alert.

R5: Repeating an erasure is safe. ✓ a second run matches zero and succeeds; duplicate enqueues collapse.

R6: A coverage guard fails on an unclassified Superset user reference.
✓ reads `information_schema` foreign keys to `ab_user` in a real Superset DB; fails naming
`table.column` for anything not handled or exempted; proven by adding a dummy table in the test.

R7: Stage 1 deployments flush the cache on erasure too, and do nothing else (decided by the owner).
✓ `SUPERSET_OAUTH_CLIENT_ID` unset or empty: erasure enqueues a **cache-only** job (flush the Superset
prefixes); no user or DB erasure runs, because guests are not stored as Superset users. The same
`superset_erasure.completed` / `.failed` audit rows are written.
✓ with Stage 2 on, the full user erasure runs and flushes the cache as part of it.

R8: The erase endpoints cannot be used by anyone but the platform.
✓ no token → 401; `Admin` or any other non-service-account token → 403; wrong tenant role → no match.
✓ `/security-review` on the diff, findings triaged.

R9: A name or email changed at the source reaches Superset (correction).
✓ with the real security manager: change the claim, log in again, `ab_user` shows the new values.

R10: The docs say what is and is not covered.
✓ `docs/local-setup.md`: backup row for Superset (not backed up, why, and what is lost on a restore), the runbook (find and
retry a failed erasure, the proxy rule that blocks `/openwind/` from outside, the breach step linking to the
organisation's incident procedure); `db-conventions.md` same-PR rule for Superset user references;
`CHANGELOG.md`; week-log; tracker row.

R11 (#709): a real SQL Lab query and a real chart CSV export (the button; the product has no SQL Lab download) each write exactly one `reporting.*` audit row,
attributed to the right tenant and keyed to the Zitadel subject.
✓ committed test against a real Superset 6.1.0 and platform DB; the standalone spec's T11 is corrected.

R12 (#716): SQL Lab returns the tenant's rows. ✓ committed test: SQL Lab count equals chart count equals
the database count for staff, an own-rows analyst and a second tenant.

R13 (#729): the NullPool guard is proven. ✓ existing tests plus a negative run against a patched copy of
Superset source; the CI job patch and ADR text are handed to a human.

R14 (ST17): cross-tenant abuse is rejected. ✓ forged or edited OIDC claim rejected at login; a query written
to dodge the tenant filter returns 0 rows (not an error); an export's audit row carries the exporter's
tenant; a username equal to another tenant's UUID is not stamped with that tenant.

## §V Invariants

- V1: every Superset-side statement is scoped by the tenant role as well as the subject.
- V2: no personal data in a queue payload, log line, response or audit row written by this feature.
- V3: tests call the real route, real purge function and real Superset endpoint, never a copied subset.
- V4: the Superset erasure never runs inside the Postgres erasure transaction.
- V5: the erase endpoints accept only the service account.
- V6: the cache is cleared by prefix scan (no `KEYS`, no `FLUSHDB`, no other Redis db).
- V7: Stage 2 is never enabled while a §G item is open.

Note on Stage 1: guests are not stored as Superset users, so there is no user data to erase, but the shared
Redis result cache (up to 300 s) can hold their query results. The owner decided that an erasure flushes
it in Stage 1 as well (R7). Open: a deployment with no Superset at all would retry forever, so it needs a
switch (D8).

## §S Security

| threat                                              | control                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| caller abuses the erase endpoints                   | service-account token only (V5); every call logged with ids and counts; protected accounts refused; `/openwind/` blocked at the proxy (residual risk) |
| wrong user erased (name or UUID-username collision) | match on `owsub` + `tenant` roles, never username (R3, R14)                                                                                           |
| tenant A erases tenant B's user                     | tenant role must equal the request's tenant (V1)                                                                                                      |
| personal data leaks through job, logs or responses  | ids and counts only (V2)                                                                                                                              |
| erasure silently fails                              | retries, final-failure audit row, alert after 7 days (R4)                                                                                             |
| Superset upgrade adds a user-referencing table      | coverage guard (R6)                                                                                                                                   |
| large table stalls the DB                           | bounded batches with a statement timeout                                                                                                              |

Residual risks, stated: Stage 2 publishes Superset to users, so the endpoints share their origin and the
service-account token is the only gate unless the proxy blocks `/openwind/` (deployment must do this; code
does not enforce it). The service account also mints guest tokens, so a leak reaches the erase endpoints too.
Exports a user already downloaded cannot be recalled.

## §D2 DPDP view (short; section numbers from a reading of the 2023 Act and the 2025 Rules; counsel confirms)

| provision (as understood; counsel confirms)                                                                              | how this spec responds                                                                       | status         |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------- |
| s.8(5) reasonable security safeguards (Rules: access control, logging, monitoring)                                       | #729, #716, #709, T17, §S                                                                    | in this spec   |
| s.8(6) breach intimation to the Board and each affected person                                                           | R10 runbook step linking to the organisation's incident procedure; decision owner is privacy | owner names it |
| s.8(7) erase when the purpose is served or consent withdrawn, unless a law requires retention; processors must erase too | R1–R5                                                                                        | in this spec   |
| s.12 correction, completion, updating and erasure                                                                        | R9 (correction), R1–R5 (erasure)                                                             | in this spec   |
| s.11 right to information (a summary, not an export)                                                                     | not built; platform-wide                                                                     | owner decision |
| log and data retention floor (Rules: security logs kept for a period believed to be one year)                            | D4: nothing built until counsel decides                                                      | **open**       |
| s.8(2) processor contract; s.10 significant fiduciary duties                                                             | D7; outside code                                                                             | owner decision |

Commencement: most obligations are believed to starting about 18 months after the Rules were notified in
November 2025; verify.

## §T Tasks

Full breakdown with verify commands, owners and the proposed plan-lock: [superset-gdpr-erasure-tasks.md](superset-gdpr-erasure-tasks.md).

| id      | task                                                                                           | req               | phase | status | depends |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------- | ----- | ------ | ------- |
| H1–H3   | Human: D1–D3, D5, D8 decided 2026-10-07; Legal / DPO on D4, D6, D7 (§Q); `approve-plan`        | —                 | 0     | open   | —       |
| T1–T12  | Prove and finish #729, #709, #716, abuse tests ST17; correct standalone spec T11               | R11–R14           | A     | todo   | H3      |
| T13–T20 | Superset side of #728                                                                          | R1,R3,R5,R6,R8,R9 | B     | todo   | T12     |
| T21–T26 | Platform side of #728 (gated paths)                                                            | R2,R4,R7          | C     | todo   | T20     |
| T27–T28 | ADR-019 gate text draft, docs and runbook                                                      | R10, #731         | D     | todo   | T26     |
| H4–H9   | Human: CI patch, ADR-019 update, proxy rule, export-route decision, breach link, sign the gate | —                 | D     | open   | —       |

phase gate: tests of the phase pass before the next phase starts.

## §B Bugs / Backprop Log

| id  | what failed                                                            | root cause                                                       | promoted to §V?                       |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| B1  | the earlier draft grew to 27 tasks of GDPR features no issue asked for | GDPR articles were treated as requirements instead of the issues | yes — §S0 and §T0 now bound the scope |

---

_spec is source of truth — update as decisions are made_
