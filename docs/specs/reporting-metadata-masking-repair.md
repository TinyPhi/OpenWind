# Reporting Event-Metadata Masking Repair

> The PII exclusion ADR-001 requires is enforced nowhere in reporting today. The masked view has
> been unusable since the migration that was meant to protect it, a later migration handed the
> raw payload back, and every chart reads the raw table anyway. Replace reporting's need for the
> payload with one derived column, take the payload off the reporting surface, and delete the
> view that never worked.

status: implemented locally and verified — not committed, awaiting manual testing
created: 2026-09-21
updated: 2026-09-22 (implemented; migrations 0117–0119 applied to the local database, results in §Verification)
issue: #106 (Stage 2 / standalone BYOQ)
depends on: `superset-standalone-with-zitadel.md` (Stage 2 is already serving users), ADR-001

---

## §G Goal

`analytics_user` cannot read raw `workflow_events.metadata` by any path, while every reporting
tile and every BYOQ query that needs the event _type_ keeps working. Tenant and own-rows
isolation are unchanged throughout: migration 0112's `security_invoker = true` stays, no new role
gains reach, and no view runs with its owner's privileges.

## §P Findings

Five problems. Evidence for each is a live query or a file, not an assertion.

### P1 — the masked view has never worked _(functional break)_

Every query an analyst runs against it fails:

```
ERROR:  permission denied for table entity_fields
```

Migration 0112 set `security_invoker = true` on `workflow_events_masked`, so privilege checks on
everything the view touches run as the caller. The view's redaction subquery joins
`entity_fields` to read each field's `sensitivity`. No migration ever granted `analytics_user`
read on that table, and 0113's grant list does not include it.

```
SELECT has_table_privilege('analytics_user','public.entity_fields','SELECT');  -- f
```

### P2 — the raw payload is readable, against 0112's explicit intent _(security)_

Migration 0112 grants eleven named columns and deliberately omits `metadata`
(`0104_reporting_tenant_isolation.sql:63-70`). Its own comment states why:

> that redaction is only worth anything while the raw column stays ungranted — otherwise the view
> is a formality the caller can step around by selecting the base table directly.

Migration 0113 line 56 then issues a blanket `GRANT SELECT ON workflow_events TO analytics_user`.
A table-level grant supersedes the column allowlist and returns `metadata`, plus the three
`origin_*` columns added after 0112 was written. Confirmed live:

```
information_schema.table_privileges  -> analytics_user | SELECT   (table-level)
information_schema.column_privileges -> includes metadata, origin_mechanism,
                                        origin_oidc_client_id, origin_performer_user_id
```

Read back under a real analyst's scope, the payload contains actor names and attached filenames:

```
{"type": "create", "fields": {}, "actorName": "Eve Tester"}
{"type": "file_attached", "fileId": "bf6bef88-...", "originalName": "$100m Offers.pdf"}
```

Tenant RLS still holds, so this is not cross-tenant. It is the PII exclusion ADR-001 mandates,
not enforced.

### P3 — masking and invoker semantics are mutually exclusive on the same object _(root cause)_

This is why P1 and P2 both persisted, and why fixing either one alone cannot work.

The view reads `metadata` in order to redact it. Under `security_invoker = true` the caller must
hold SELECT on every column the view references, including that one. So `analytics_user` can use
the masked view only while it can also read the raw column the view exists to hide. Migration
0112 introduced both halves of this contradiction in a single change: it removed the metadata
grant _and_ turned on invoker semantics, which left the view unusable rather than protective.

The sequence, reconstructed from the migrations and confirmed against live state:

| after | metadata granted?          | masked view              |
| ----- | -------------------------- | ------------------------ |
| 0112  | no                         | fails on `metadata`      |
| 0113  | yes, via table-level grant | fails on `entity_fields` |

It has never returned a row to an analyst. This is the reason the view is deleted rather than
repaired — see §D.

### P4 — no chart uses the masked view _(scope)_

All five virtual datasets query raw `workflow_events`. They back 24 of 35 charts across both the
embedded and standalone paths. Zero charts reference `workflow_events_masked`.

So masking is absent from the whole reporting surface, not only from BYOQ. BYOQ is simply where a
human can reach the payload by hand.

Each of the five uses exactly one key from the payload and nothing else:

```
my_tickets_assigned    metadata->>'type' = 'comment'
my_tickets_created     metadata->>'type' = 'comment'
ticket_first_response  metadata->>'type' = 'comment'
ticket_list            metadata->>'type' = 'comment'
ticket_dwell_time      COALESCE(metadata->>'type','transition') <> 'comment'
```

That single key is the entire reason reporting touches the payload. All five also read the
`comment` column, which is why it stays granted — see §D.

### P5 — provisioning drift, minor

- `ReportingNoAccess` is never stripped at login. Both SSO accounts hold it alongside their real
  roles, because `auth_user_oauth` rebuilds only the `tenant:` and `owuser:` prefixes. Harmless
  today since the role is empty, but it makes the no-access signal meaningless.
- `entity_instances` is registered twice as a dataset.
- Raw `workflow_events` is registered as a dataset, granted to no role.

## §D Decisions

**Add a derived `event_type` column to `workflow_events`, maintained by the database, take
`metadata` off the reporting surface, and delete `workflow_events_masked`.**

Since `metadata->>'type'` is the only key reporting reads (P4), one derived column replaces the
payload completely and the contradiction in P3 is dissolved rather than worked around.

| decision                      | ruling                       | why it breaks nothing                                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the masked view               | **delete it**                | it has never returned a row, no chart uses it, no application code references it. Masking becomes exclusion rather than redaction, which is the stronger control. ADR-001 needs a line amended to say so (T8)                                                     |
| `origin_*` columns            | **do not grant**             | no dataset reads them. They reached the role only through 0113's blanket grant                                                                                                                                                                                    |
| `comment` column              | **keep granted**             | all five datasets read it, so removing it takes down the same 24 charts. ADR-001 targets field values marked pii or financial; workflow transition comments are operational text of a different kind. Recorded rather than assumed, and raised separately as OQ-1 |
| `entity_fields` grant         | **not needed**               | only the deleted view required it. The interim grant proposed in an earlier draft of this spec is dead work and has been removed                                                                                                                                  |
| exposure before the fix lands | **ship gate, no action now** | nothing is committed. The Superset directory and migrations 0112–0116 are untracked, so no deployment exists. The exposure is a local database of seeded test data. The control is that T5 blocks Stage 2 shipping, recorded in §T                                |

### Alternatives rejected

**Run the masked view with definer semantics under a safe owner.** Rejected. Migration 0112 set
`security_invoker = true` to close a measured cross-tenant hole: a tenant owning none of the rows
got zero from the base table and all 48 through the view
(`0104_reporting_tenant_isolation.sql:26-30`). Any return to owner-evaluated privileges walks back
into a documented incident, and the restrictive `reporting_own_rows` policy is bound to
`analytics_user` so it would silently stop applying, leaking within the tenant.

**Accept raw metadata and control it by role membership.** Rejected on production grounds. The
Stage 2 threat model already lists this as blocked ("selecting a PII column ADR-001 excludes ->
P2 — not granted to the role"). Accepting it leaves that row unmitigated while the document
asserts otherwise, which is an implemented-control gap under SOC 2 CC6.1 rather than a recorded
risk. It also substitutes configuration discipline for a technical control, which is the pattern
this codebase rejects everywhere else.

**A stored generated column.** Rejected as the mechanism. On PostgreSQL 16 adding one rewrites the
table under an exclusive lock, and `workflow_events` is append-heavy. Virtual generated columns
would avoid the rewrite but arrived in PostgreSQL 18. Use a nullable column, a batched backfill
and a trigger instead.

## §C Constraints

| constraint           | value                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| isolation            | unchanged. `security_invoker` semantics are not revisited, `analytics_user` stays `NOBYPASSRLS`, no new role, no definer object                                                      |
| blast radius         | reporting only, with one stated exception: the column and trigger live on `workflow_events`, a core table the engine writes to                                                       |
| grant discipline     | column-level, matching 0009 and 0112. No table-level grants on any table holding a payload or free-text column                                                                       |
| availability         | no full-table rewrite and no exclusive lock held for the backfill                                                                                                                    |
| write path           | the trigger adds no logic and no application change. Computing the value in the engine instead is out of scope, since a database-level trigger cannot be bypassed by a future writer |
| ordering             | no step may leave reporting more broken than it found it. The revoke lands after the charts are confirmed                                                                            |
| unaffected by design | the embedded guest-token path (same datasets, moves with them) and the in-app BYOQ sidebar at `/reporting` (runs through the API as `app_user`, never uses the reporting role)       |
| out of scope         | export limits (Stage 2 T12), MFA, single-logout, session values, DPIA                                                                                                                |

## §I Interfaces

New column on `workflow_events`:

```
event_type  text  NULL      -- mirrors metadata->>'type'; NULL where the key is absent
```

Maintained by a `BEFORE INSERT OR UPDATE` trigger. Readers treat NULL the way the current SQL
treats a missing key, so `ticket_dwell_time`'s `COALESCE(..., 'transition')` keeps its meaning.

Grant shape after this work, on `workflow_events`:

```
GRANT SELECT (id, tenant_id, workflow_id, instance_id, from_state, to_state,
              triggered_by, actor_id, comment, idempotency_key, created_at,
              event_type) ON workflow_events TO analytics_user;
```

0112's eleven columns plus `event_type`. `metadata` and the three `origin_*` columns are not
granted. No grant is issued on `entity_fields`; the view that needed it is deleted.

## §R Requirements

R1: `analytics_user` cannot read raw event payloads by any path.
✓ `SELECT metadata FROM workflow_events` is refused for that role.
✓ No table-level SELECT grant exists on `workflow_events` for that role; the grant is column-level.
✓ A column added to `workflow_events` in future is not readable by reporting unless granted.

R2: every chart that renders today still renders, with the same numbers.
✓ All 24 charts on the five datasets return identical values before and after the repoint.
✓ `ticket_dwell_time`'s absent-key case still classifies as `transition`, not as a comment.
✓ The embedded path is verified separately from standalone, not assumed to follow.

R3: isolation is exactly what it was.
✓ `analytics_user` remains `NOBYPASSRLS`; no role is created or granted membership anywhere.
✓ A cross-tenant probe from SQL Lab returns zero rows, not an error.
✓ A non-staff analyst still sees only tickets they created or were assigned.

R4: no broken object is left behind.
✓ `workflow_events_masked` is dropped, not left unusable in the schema.
✓ ADR-001 records that reporting achieves exclusion rather than redaction.

R5: the repair survives a restart and a re-provision.
✓ `bootstrap.py` and `tiles.yaml` both carry the repointed SQL, so a container restart does not
revert it.
✓ 0113's blanket grant is superseded by a forward migration, not by a manual statement.

R7: a measurement that does not exist is never reported as a number.
✓ An aggregate over nothing returns null, not `0`, for every operation except
count, where zero is a true answer.
✓ The client is told which kind of nothing it is: no matching tickets, versus
matching tickets with nothing to measure.
✓ A group with no measurable value is marked absent rather than drawn as a
zero-height bar.
✓ Tests exercise the null path, which the previous suite never did.

R8: a dataset never advertises a column it cannot serve.
✓ Provisioning prunes dataset columns the reporting role cannot read.
✓ The prune list is read from the database's own grants, so a future revoke
prunes itself and a re-grant reappears through normal introspection.

R6: the derived column cannot drift from the payload.
✓ The trigger fires on insert and on update, so a later edit to `metadata` cannot leave
`event_type` stale.
✓ Backfill covers every existing row, verified by a count of rows where the two disagree.

## §S Threat Model (STRIDE)

Mandatory per `.claude/rules/security.md`.

| threat | abuse case                                                                           | blocked by                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| I      | analyst selects `metadata` in SQL Lab and reads actor names, filenames, field values | R1 — column not granted                                                                                                            |
| I      | analyst reaches the payload through the masked view instead                          | the view no longer exists (§D)                                                                                                     |
| I      | a future column on `workflow_events` re-exposes a payload                            | R1 — column-level grants mean new columns are ungranted by default                                                                 |
| I      | analyst joins a table with no tenant filter                                          | unchanged. RLS `tenant_read` is permissive `TO public` and applies to every role                                                   |
| I      | free text pasted into `comment` carries PII an analyst then reads                    | **accepted and recorded**, see OQ-1. Not closed by this work                                                                       |
| E      | the repair is implemented by flipping the view to definer semantics                  | §D — rejected explicitly; reverts 0112 and disables the restrictive own-rows policy                                                |
| E      | non-staff analyst sees a colleague's tickets                                         | unchanged. `reporting_own_rows` is restrictive and bound to `analytics_user`, which this work does not alter                       |
| T      | the derived column is edited to misrepresent an event                                | recomputed by the trigger on every write; it cannot be set to a value that disagrees with the payload                              |
| R      | payload read before the revoke lands is untraceable                                  | bounded by the ship gate (§D, T5). SQL Lab queries are already appended to the platform audit store via `record_reporting_audit()` |
| D      | the backfill locks the events table                                                  | §C — batched, no exclusive lock, no table rewrite                                                                                  |

Carry as acceptance criteria: a tenant A analyst attempts each of these against tenant B and gets
zero rows, not an error that confirms existence.

## §V Invariants

- No table-level SELECT grant on any reporting table that holds a payload or free-text column.
- Reporting reads a derived, non-sensitive projection of event metadata, never the payload.
- A new column on a granted table is unreadable by reporting until someone grants it deliberately.
- Isolation changes and grant changes do not travel in the same migration as a semantics change.
- A control that cannot work is removed, not left in place implying protection it does not give.
- A grant change is verified through the surface that consumes it, not through hand-written SQL
  that happens to name its columns. Superset rewrites queries; the only trustworthy check is the
  statement it actually sends, replayed verbatim or driven through a guest token.
- A test for a known breakage is first shown to fail against the unfixed system. A passing probe
  against a visibly broken dashboard means the probe is wrong, not the dashboard.
- A legacy permission never implies its REST counterpart. `can_sqllab` does not grant
  `can_read on SQLLab`, and `can_explore` does not grant `can_read on Explore`. Granting a
  feature means granting both, and verifying it by using the feature rather than by reading
  the permission list — the list looked complete both times it was wrong.

## §T Tasks

One sequence. Nothing is fixed in an early phase and unfixed in a later one.

| id  | task                                                                                                                                                                                                              | phase | status                      | depends |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------- | ------- |
| T1  | Migration `0117`: add nullable `event_type`, batched backfill, `BEFORE INSERT OR UPDATE` trigger. No rewrite, no exclusive lock                                                                                   | 1     | **done**                    | —       |
| T2  | Verify backfill completeness: zero rows where `event_type IS DISTINCT FROM metadata->>'type'`                                                                                                                     | 1     | **done**                    | T1      |
| T3  | Repoint the five dataset definitions in `bootstrap.py` from `metadata->>'type'` to `event_type`. **Correction:** the dataset SQL lives only in `bootstrap.py`; `tiles.yaml` carries chart config, not dataset SQL | 2     | **done**                    | T2      |
| T4  | Confirm the datasets return identical values before and after the repoint                                                                                                                                         | 2     | **done**                    | T3      |
| T5  | Migration `0118`: revoke the table-level grant from 0113, re-assert the column list from §I. **Ship gate for Stage 2**                                                                                            | 3     | **done**                    | T4      |
| T6  | Migration `0119`: drop `workflow_events_masked`, with pointer comments added to 0009 and 0017                                                                                                                     | 3     | **done**                    | T5      |
| T7  | Abuse-case tests from §S: raw metadata refused, cross-tenant zero rows, non-staff own-rows intact                                                                                                                 | 3     | **done** (ad hoc; see OQ-3) | T5      |
| T8  | Amend ADR-001: reporting achieves PII exclusion by withheld grant, not by redaction                                                                                                                               | 4     | **done**                    | T6      |
| T9  | P5 cleanups: strip `ReportingNoAccess` at login; remove retired and stranded datasets                                                                                                                             | 4     | **done**                    | —       |
| T10 | Update `superset-standalone-with-zitadel.md` and the roadmap tracker, both of which still record Stage 2 as deferred with every task todo while it serves users                                                   | 4     | **done**                    | —       |
| T11 | Promote the §S probes into a committed test file rather than ad-hoc psql runs                                                                                                                                     | 5     | todo                        | T7      |

### Round two (2026-09-22) — found by the regression sweep, same defect class

The sweep that verified T1–T10 turned up two more instances of the identical
pattern, plus a measure that lies. All three are now fixed.

| id  | task                                                                                                                                                                           | status                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| T12 | Migration `0120`: `tenant_users` from a table-level grant to `user_id, tenant_id, display_name`. Analysts could read user **email addresses**, which ADR-001 excludes outright | **done**                                      |
| T13 | Migration `0121`: add `reporting_title` and `reporting_department` to `entity_instances`, trigger-maintained mirrors of the only two payload keys reporting reads              | **done**                                      |
| T14 | Repoint the datasets onto the projections; prove equivalence under both scopes                                                                                                 | **done**                                      |
| T15 | Migration `0122`: revoke the table-level grant on `entity_instances`; withhold `fields`, `search_vector` and the three `origin_*` columns                                      | **done**                                      |
| T16 | `query.ts`: stop coalescing a non-count aggregate to `0`. An absent measurement now reports as absent and says why                                                             | **done**                                      |
| T17 | Five new tests covering the absent-measurement paths, which the existing suite never exercised because its mocks always returned a value                                       | **done**                                      |
| T18 | `bootstrap.py`: prune dataset columns the reporting role cannot read, asked of the database rather than hard-coded, so it tracks grants instead of drifting from them          | **done**                                      |
| T19 | Set `sla_hours` on the Helpdesk workflow states, or decide the product does not use SLAs there                                                                                 | **todo — not an engineering call** (see OQ-5) |

### Round three (2026-09-22) — making standalone usable without SQL

The standalone site offered analysts exactly one way to compose a question:
SQL Lab. That is the wrong tool for the people this is built for, who are not
developers. Superset's own point-and-click builder, Explore, was already
licensed, already permitted to this role, and simply unreachable.

| id  | task                                                                                                                                                                                                                                                                                     | status                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| T20 | Grant `menu_access` on `Data` and `Datasets`. Datasets is the front door to Explore; without it the role could only view charts somebody else had built. Both the category and the link, for the same reason the SQL Lab block grants four entries. `Databases` deliberately not granted | **done**                               |
| T21 | Migration `0123`: add `reporting_priority`, extend the existing projection trigger to maintain it, backfill, grant it                                                                                                                                                                    | **done**                               |
| T22 | Expose `priority` on the three ticket datasets, tidied for display in the dataset rather than in the column                                                                                                                                                                              | **done**                               |
| T23 | Add a select-filter bar: Priority, Status, Department and Assignee on the org dashboard; Priority and Status on the personal one. Options are read from the column, so new values appear without a config change                                                                         | **done**                               |
| T24 | Decide what `severity` is for, or remove it and the funnel chart built on it                                                                                                                                                                                                             | **todo — product decision** (see OQ-7) |

Verified after the change: the question that prompted this — high priority
tickets due within seven days — returns a real row through the dataset, having
previously been unanswerable. All 35 charts remain attached, all five datasets
return their original row counts, and the API reporting tests still pass at 87.

phase gate: **T5 does not land until T4 is confirmed by eye on both paths.** Revoking before the
repoint is verified takes 24 charts down. T5 is also the ship gate: Stage 2 does not go to a real
deployment with the payload still granted.

## §Verification

Measured against the local database on 2026-09-22, after applying 0117–0119 and re-running
provisioning. Nothing here is inferred from the code.

**Backfill and trigger.** Zero rows where `event_type IS DISTINCT FROM metadata->>'type'`, across
1354 events. An insert that sets no `event_type` comes back classified by the trigger; the probe
was rolled back rather than left behind.

**Dataset equivalence, the load-bearing check.** Each dataset's stored SQL was run in its old and
new form side by side, comparing row counts and the symmetric difference in both directions. Run
once under the staff scope and again under the non-staff own-rows scope:

| dataset               | staff rows | own-rows rows | difference, either direction |
| --------------------- | ---------- | ------------- | ---------------------------- |
| ticket_dwell_time     | 977        | 441           | 0                            |
| ticket_first_response | 189        | 87            | 0                            |
| ticket_list           | 302        | 140           | 0                            |
| my_tickets_created    | 302        | 140           | 0                            |
| my_tickets_assigned   | 302        | 140           | 0                            |

The own-rows column being smaller is the point: the narrowing still applies, and the rewrite does
not disturb it.

**After the revoke.** All five datasets execute as `analytics_user` with the same counts as the
staff column above. All 35 charts remain attached to six datasets, all on the managed connection.

**Refusals.** `SELECT metadata FROM workflow_events` and `SELECT *` both return `permission denied
for table workflow_events`. So does `origin_performer_user_id`. The twelve allowlisted columns
read normally.

**Isolation.** A probe claiming a tenant that owns no rows returns 0 rows, not an error. An
unstamped connection returns 0. Fail-closed behaviour is intact.

**Provisioning.** Re-running it removed three leftovers — the dropped view's dataset, and an
`entity_instances` and a `workflow_events` dataset stranded on the superseded connection — while
leaving every chart in place. Superset restarted healthy and the Zitadel redirect still issues a
302 with the correct client and scopes.

## Open Questions

Only genuinely open items remain. The five questions in the previous draft are resolved in §D.

| ID   | question                                                   | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Does free text in `comment` need its own treatment?        | Kept granted because all five datasets read it and ADR-001's scope is field values marked pii or financial. But it is text a person typed and can contain anything. This is a separate decision with its own owner, not something this spec settles.                                                                                                                                                                                                                                                        |
| OQ-2 | Who signs off the ship gate at T5?                         | The gate is only real if someone owns it. Names the person who confirms the revoke landed before Stage 2 reaches a deployment. The migration is written and applied locally, so what remains is confirming it runs wherever this deploys.                                                                                                                                                                                                                                                                   |
| OQ-3 | Where do the §S probes live permanently?                   | They were run ad hoc against the local database and their results are in §Verification, but nothing re-runs them. Until T11 lands, a future migration could reopen this exposure exactly as 0113 did and no test would notice. This is the same class of gap that caused B2.                                                                                                                                                                                                                                |
| OQ-5 | What are the SLA hours for the Helpdesk workflow?          | No state that tickets actually occupy sets `sla_hours`, so the SLA Margin measure and the "SLA Margin - Distribution" chart have nothing to show. The code now says "No SLA configured" instead of inventing a zero, which is honest but still empty. Someone has to decide the numbers, or decide that Helpdesk does not use SLAs and the measure should be hidden for it. Not an engineering call.                                                                                                        |
| OQ-7 | What is `severity` for, and should it stay?                | It is not priority — confirmed, they are different concepts and `priority` is now exposed separately. But `severity` has no field definition anywhere in `entity_fields`, so the dataset hardcodes `'Not set'::text` and all 302 rows carry that one value. A funnel chart, "Tickets by Severity", is built on it and can only ever draw one segment. Either seed a real severity field, or drop the column and the chart. A dimension that answers every question identically is worse than an absent one. |
| OQ-8 | Are the duplicate dashboards intentional?                  | Provisioning reports filters applied to the two dashboards it manages by slug, but the metadata table also holds a second "My Performance" and a "Tenant Overview (MIS)", both with no filters and neither managed here. Same leftover shape as the stranded datasets T18 now cleans up. Worth confirming before someone opens the wrong one.                                                                                                                                                               |
| OQ-6 | Should the three remaining table-level grants be narrowed? | `entity_types`, `workflows` and `workflow_states` still have whole-table grants. ADR-001 permits all columns on each, being config rather than customer data, so this is consistent today. But it is the same shape that produced B2, B6 and B7 three times, and a config table can grow a column nobody reviewed.                                                                                                                                                                                          |
| OQ-4 | Should the migration journal be reconciled?                | **Resolved.** The reporting series 0112–0124 is in `meta/_journal.json` and applies through `run-migrations` on a clean database, with or without `analytics_user` present.                                                                                                                                                                                                                                                                                                                                 |

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                         | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | promoted to §V?                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| B1  | Masked view errors on every query with `permission denied for table entity_fields`                                                                                                                                  | 0112 turned on invoker semantics; no migration granted the caller read on a table the view's redaction subquery joins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | yes — §V, a control that cannot work is removed                         |
| B2  | Raw `metadata` readable by reporting, against 0112's written intent                                                                                                                                                 | 0113 line 56 issued a table-level grant that supersedes 0112's column allowlist, restoring `metadata` and sweeping in three later columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | yes — §V, no table-level grants                                         |
| B3  | The masked view can never satisfy both goals at once                                                                                                                                                                | Owner-provided masking and caller-evaluated RLS were applied to the same object in the same migration; the view must read the column it hides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | yes — §V, isolation and grant changes travel separately                 |
| B4  | Masking absent from all 24 charts                                                                                                                                                                                   | Datasets were written against the base table; nothing enforced that the masked view was the only path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | yes — R1                                                                |
| B5  | Stage 2 opened through its own phase gate                                                                                                                                                                           | The standalone spec requires the grant repair verified before analysts can write queries. SSO shipped, 0113 had reintroduced the table grant, and nothing checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | process gap — see T10                                                   |
| B6  | Analysts could read user email addresses                                                                                                                                                                            | 0113 granted `tenant_users` table-level to get display names for charts. ADR-001 excludes the table outright. The grant took `email` along with the one column that was wanted                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | yes — §V, no table-level grants                                         |
| B7  | Analysts could read the ticket form payload and its search index                                                                                                                                                    | 0113 granted `entity_instances` table-level. ADR-001 says "all columns except `fields`". `search_vector` is derived from the payload, so granting it re-exposes the same content as lexemes                                                                                                                                                                                                                                                                                                                                                                                                                                                              | yes — §V, no table-level grants                                         |
| B8  | SLA Margin reported a confident `0` with nothing to measure                                                                                                                                                         | The aggregate was wrapped in `COALESCE(..., 0)`. No workflow state that tickets occupy sets `sla_hours`, so the measure is NULL for every row and the zero was indistinguishable from a real result. B1 caught the same class when the fabricated value was `1`; replacing it with `0` fixed the symptom, not the defect                                                                                                                                                                                                                                                                                                                                 | yes — R7                                                                |
| B9  | The test suite could not have caught B8                                                                                                                                                                             | Its mocks always return a value for the aggregate, so the NULL path was never exercised. Five tests added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | yes — R7                                                                |
| B13 | 23 of 35 embedded charts failed with `permission denied for table entity_instances`, while every column they used was granted                                                                                       | Superset applies a guest token's row filter to a virtual dataset by **rewriting the base table into a filtered subquery** — `FROM (SELECT * FROM entity_instances WHERE …) AS ei` — and `SELECT *` requires table-level SELECT, which 0122 removed. Not a missing column: a query shape that column-level grants cannot satisfy. Fixed by `0124`, a `reporting_instances` view holding only the safe columns, which a wildcard may read in full. **Every check written for 0122 named its columns, so every check passed**; the bug was only reproduced by replaying the failing statement verbatim from the Superset log                                | yes — §V, verify a grant change through the surface that uses it        |
| B14 | The first attempt to reproduce B13 through the embedded path passed while the dashboard was visibly broken                                                                                                          | The probe minted a guest token without the `entity_instances` row-filter rule, which is what triggers the rewrite. A test that cannot fail proves nothing — the rule was added, the probe then failed exactly as the dashboard did, and only then was the fix applied                                                                                                                                                                                                                                                                                                                                                                                    | yes — with B13                                                          |
| B15 | Every select filter (Priority, Status, Department, Assignee) rendered `<NULL>` on both embedded and standalone, while date filters worked                                                                           | `bootstrap.py` wrote native-filter targets as `datasetUuid`, which is Superset's export-file format — its importer converts it to a numeric `datasetId` (`commands/dashboard/importers/v1/utils.py`). Written straight into live `json_metadata`, the filter had no dataset, never issued a query, and rendered `<NULL>`. Date filters need no dataset, which is why only select filters broke. Fixed by writing `datasetId: dataset.id`. First misdiagnosed as a permission gap: extra guest-role grants were added, proven unnecessary (the filters return correctly scoped values without them), and removed again, restoring the original guest role | yes — §V, provisioning writes the runtime format, not the export format |
| B16 | A chart saved from Explore under an existing name made the next provisioning run crash (`MultipleResultsFound`), so one user clicking Save broke every later deploy                                                 | `ensure_chart` used `.one_or_none()` on name + dataset. It now updates the dashboard-attached (provisioned) chart and leaves user copies untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | yes — §V, provisioning never modifies or deletes user content           |
| B11 | Opening any dataset in Explore failed with "Missing dataset — the dataset linked to this chart may have been deleted", zero metrics, zero columns, and a FORBIDDEN toast, while the dataset was present and healthy | `GET /api/v1/explore/` answered 403. `ExploreRestApi` sets `class_permission_name = "Explore"` and is gated by `can_read on Explore`, separately from the legacy `can_explore on Superset` that T20 relied on. **This is the identical split already documented in this file's own SQL Lab grant block** (`can_sqllab` versus `can_read on SQLLab`) — the lesson was written down and then repeated three rounds later, because the legacy permission name reads as though it covers the feature. Found by manual testing, not by any check here                                                                                                         | yes — §V, a legacy permission never implies its REST counterpart        |
| B12 | Filter dropdowns in Explore would have offered no values                                                                                                                                                            | `can_get_column_values on Datasource` was never granted. Not yet observed, because B11 stopped anyone reaching a filter row — it would have been the next failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | yes — with B11                                                          |
| B10 | Datasets advertised columns the role cannot read                                                                                                                                                                    | Nothing pruned dataset columns after a grant was withdrawn, so Explore offered `fields` and friends and a query on them returned a permission error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | yes — R8                                                                |

---

_spec is source of truth — update as decisions are made_
