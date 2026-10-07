# Implementation Plan: Stage 2 gate — Superset erasure (#728) and the other open gate issues

**Spec:** docs/specs/superset-gdpr-erasure.md
**Generated:** 2026-10-06 (rewritten after scope review)
**Status:** not started — plan-lock NOT frozen; nothing below runs until a human types `approve-plan`

---

## How this plan is organised

- **Phase 0** is human decisions. **Phase A** finishes the already-written fixes with the proofs their issues ask for. **Phase B** builds the Superset side of #728. **Phase C** builds the platform side (gated paths). **Phase D** is docs and the Stage 2 gate text.
- One task = one commit, test first, ends with its `verify` command green.
- Workflow files and ADRs are never edited by the agent (H4, H5).
- Test harness for Phases A and B: throwaway Postgres databases (a Superset schema from `superset db upgrade`, and a platform DB with the repo's migrations applied and `analytics_user`), plus a real Redis db, all driven from the pinned `openwind-superset:6.1.0` image. Nothing touches the running stack's databases or Redis db 2. Script: `docker/superset/run-integration-tests.sh` (T1).
- Existing local branches carrying finished code: `fix/PLAT-729-nullpool-guard`, `fix/PLAT-709-audit-mapping`, `fix/PLAT-716-sqllab-tenant-stamp`. They are inputs to Phase A, not part of it.

---

## Phase 0 — Decisions (human)

**Gate:** H1 (closed 2026-10-07) and H3. H2 is carried as open questions in the PR (spec §Q) and does not block.

| task | owner       | what                                                                                                                                                                                              | requirement |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| H1   | track owner | D1, D2, D3, D5, D8 decided 2026-10-07. D5: Superset's database stays out of backup.sh; no restore step is needed for Superset.                                                                    | —           |
| H2   | Legal / DPO | D4 (retention of typed SQL and logs, under DPDP), D6 (named approver, date, reference), D7 (fiduciary vs processor). D4 gates **no** task here; it gates the retention work that is out of scope. | —           |
| H3   | human       | Review and type `approve-plan`; the agent then freezes the plan-lock from the payload at the end of this file.                                                                                    | —           |

---

## Phase A — Prove and finish #729, #709, #716, and the abuse tests (Superset side; no gated paths)

**Gate:** all Phase A tests pass inside the pinned image against real databases. T12 is the one Phase A task that runs after T15 (Phase B), so it closes Phase A late.

| task | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | issue / req    | status                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| T1   | Harness: `docker/superset/run-integration-tests.sh` creates the throwaway databases, migrates both, starts the check, tears down. First test: it fails if the platform DB is missing the binding key (an empty key table makes every reporting audit write fail).                                                                                                                                                                                                                 | harness        | in progress (not in the repository yet)                                  |
| T2   | #729 negative proof: run the guard against a copy of Superset's source with `nullpool` patched to `False`, and with a `nullpool=False` caller added; both must refuse to start. (The positive case and unit tests already exist.)                                                                                                                                                                                                                                                 | #729 / R13     | done (#790)                                                              |
| T3   | **#709 real-run test:** a real SQL Lab query and a real chart CSV export (a form post, as the button sends it) through Superset's own test client write **exactly one** `reporting.query_executed` and one `reporting.exported` row in the platform DB, with the right tenant; a chart-data JSON call writes none. Already done: the request-format fix, logger tests with real request shapes (the DB write is mocked) and a live manual proof; this task adds the real-DB test. | #709 / R11     | in review (#799)                                                         |
| T4   | **#716 real-run test:** `SELECT count(*)` in SQL Lab equals the chart count equals the database count for staff, an own-rows analyst, and a second tenant's user.                                                                                                                                                                                                                                                                                                                 | #716 / R12     | done (#798)                                                              |
| T5   | ST17(2) forged claim: an edited or unsigned OIDC userinfo/ID token is rejected at login and creates no user.                                                                                                                                                                                                                                                                                                                                                                      | SST17 / R14    | deferred: owner decision, 2026-10-07                                     |
| T6   | ST17(1) filter-dodging query: queries written to bypass the tenant filter (other tenant's id in `WHERE`, `SET app.tenant_id`, `RESET`, a CTE, `UNION`) return 0 rows, not an error.                                                                                                                                                                                                                                                                                               | SST17 / R14    | deferred: owner decision, 2026-10-07                                     |
| T7   | ST17(3) export attribution: an export by tenant B's user writes an audit row with tenant B, never A.                                                                                                                                                                                                                                                                                                                                                                              | SST17 / R14    | deferred: owner decision, 2026-10-07                                     |
| T8   | Username collision: a Superset username equal to another tenant's UUID is not stamped with that tenant (an earlier suspicion; a test settles it). If it fails, fix in `DB_CONNECTION_MUTATOR` in the same task.                                                                                                                                                                                                                                                                   | SST17 / R14    | deferred: owner decision, 2026-10-07; the finding is reported separately |
| T9   | Re-run the three finished branches' unit tests together with T2–T8 after merging them locally.                                                                                                                                                                                                                                                                                                                                                                                    | #709 #716 #729 | after #799 merges                                                        |
| T10  | Correct T11 (marked done but wrote nothing) in `docs/specs/superset-standalone-with-zitadel.md`.                                                                                                                                                                                                                                                                                                                                                                                  | #709 / R11     | in review (#799)                                                         |
| T11  | ~~Streaming export failing test.~~ **Dropped 2026-10-07:** the product has no SQL Lab download (owner). The audit mapping still covers the export routes in case a role change opens them.                                                                                                                                                                                                                                                                                        | found          | dropped                                                                  |
| T12  | #709 follow-up (needs T15): the audit writer records the Zitadel subject (from `owsub:`) as actor, not the login name, as the standalone spec's T11 requires.                                                                                                                                                                                                                                                                                                                     | #709 / R11     | in review (#799)                                                         |

**Verify (Phase A):** `docker/superset/run-integration-tests.sh a`.

---

## Phase B — Superset side of #728

**Gate:** all Phase B tests pass; Phase A still green.

| task | what                                                                                                                                                                                                                                                                         | req        | status |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| T13  | **Prove-it:** `test_erasure.py` seeds a throwaway Superset DB (real schema) with a user and a row in every `delete` class, a second user, a second tenant, and Redis keys under both prefixes; calls the erase entry point; asserts nothing is left. Fails today.            | R1, R3, V3 | todo   |
| T14  | Classification: `ERASURE_HANDLED` / `ERASURE_EXEMPT` for the 67 references exactly as in spec §I; a human reviews it before T16 builds on it (`tasks.user_id` and the ownership-link rows are the judgement calls).                                                          | R6         | todo   |
| T15  | Login marker and refresh: `auth_user_oauth` adds `owsub:<subject>` to every user (no duplicate on re-login) and refreshes an existing user's name and email from the claims.                                                                                                 | R3, R9     | todo   |
| T16  | Erase logic: find by `owsub` + `tenant` roles; refuse `admin` and the service account; delete the `delete` classes in bounded batches with a statement timeout; delete the user's `owsub:`/`owuser:` roles; anonymise `ab_user`; idempotent.                                 | R1, R3, R5 | todo   |
| T17  | Endpoints `POST /openwind/erasure/user` and `/tenant`: service-account only; counts-only response; one log line with ids only. Negative tests: no token → 401, `Admin` → 403, wrong tenant → 0 matches.                                                                      | R3, R8, V5 | todo   |
| T18  | Redis flush: prefix `scan` + `unlink` for `superset_` and `superset_data_` in Superset's db only, also exposed as a cache-only entry point (`POST /openwind/erasure/cache`, service-account only) for Stage 1; real Redis proves other prefixes and other dbs are untouched. | R1, R7, V6 | todo   |
| T19  | FK coverage guard against the real Superset DB, proven by adding a dummy table in the test.                                                                                                                                                                                  | R6         | todo   |
| T20  | Phase B verify script and README note in `docker/superset/`.                                                                                                                                                                                                                 | —          | todo   |

**Verify (Phase B):** `docker/superset/run-integration-tests.sh b`.

---

## Phase C — Platform side of #728 (gated; needs the approved plan-lock)

**Gate:** unit + isolation tests pass; Phases A and B still green.

| task | what                                                                                                                                                                                                                                                                                                            | req        | status |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| T21  | Migration: extend `audit_log_action_check` with `superset_erasure.completed` / `.failed` (down block as 0115); add both to `packages/audit` `outcome.ts` and `request-kind.ts`; extend the audit-action tests.                                                                                                  | R4         | todo   |
| T22  | `@platform/config`: optional `SUPERSET_OAUTH_CLIENT_ID` (empty = unset) and `isSupersetStage2Enabled`; optional `SUPERSET_ERASURE_ENABLED` (D8); unit tests for unset, empty, set.                                                                                                                              | R7, D3, D8 | todo   |
| T23  | Worker: queue `superset-erasure` and worker; login then POST; deterministic job id; back-off capped at 1 h, attempts spanning ≥24 h; warning on first failure; `completed` on success, `failed` on the final attempt; alert after 7 days with no `completed`; tested against a fake Superset (down, slow, 403). | R4, R5     | todo   |
| T24  | `DELETE /users/:userId`: enqueue **after** commit; a full job when Stage 2 is on, a cache-only job when it is off, nothing when `SUPERSET_ERASURE_ENABLED` is off; never throws into the response. Real-handler isolation test: Superset down → 200, Postgres rows gone, job queued.                            | R1, R4, R7 | todo   |
| T25  | Tenant purge: enqueue the `tenant` job (or cache-only when Stage 2 is off) after the DB purge; real purge-function test with two tenants.                                                                                                                                                                       | R2, R7     | todo   |
| T26  | End-to-end on the local stack: a real Zitadel user logs in to Superset, runs a query, is erased through the real route; a recorded check of every handled table, Redis, the audit rows and the job, written to the week-log.                                                                                    | R1–R5      | todo   |

**Verify (Phase C):** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation` (a down Docker stack is a blocker, never a silent skip).

---

## Phase D — Docs and the Stage 2 gate text

**Gate:** §R acceptance met; review and security review clean.

| task | what                                                                                                                                                                                                                                                                                                             | req     | status |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| T27  | Draft the ADR-019 "Stage 2 gate criteria" section for a human, as a draft kept outside `docs/decisions` (ADRs are human-authored): owner, criteria with links to #709/#716/#728/#729 and the abuse tests, enablement steps with the OpenBao step replaced by environment variables, deadline left for the owner. | #731    | todo   |
| T28  | Docs: `docs/local-setup.md` backup row (not backed up, why, what is lost) and runbook (find/retry a failed erasure, the proxy rule, the breach step linking to the incident procedure); `db-conventions.md` rule; `CHANGELOG.md`; week-log; tracker row; run `/review` and `/security-review`.                   | R10, R8 | todo   |

---

## Human tasks outside the agent's remit

| task | owner              | what                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H4   | track owner        | Apply and review the CI patch for #729 (build the Superset image, run the Superset test files) and add an integration-test job for T3–T8 and T13–T19; workflow edits are human-only.                                                                                                                      |
| H5   | track owner        | Update ADR-019 from T27: the gate criteria (#731), the NullPool assertion reference (#729) and OQ-3 resolved (#728).                                                                                                                                                                                      |
| H6   | deployment owner   | Add the reverse-proxy rule blocking `/openwind/` from outside before Stage 2 is enabled.                                                                                                                                                                                                                  |
| H7   | owner              | ~~Decide the streaming-export defect~~ closed 2026-10-07 with T11 (no SQL Lab download in the product). H7a is decided: Stage 1's shared cache is flushed on erasure too (spec R7).                                                                                                                       |
| H8   | security / privacy | Name who decides on breach notification and give the incident-procedure link the runbook uses.                                                                                                                                                                                                            |
| H9   | named owners       | Sign the Stage 2 gate (spec §G, V7). Nothing sets `SUPERSET_OAUTH_CLIENT_ID` for real users before this.                                                                                                                                                                                                  |
| H10  | track owner        | Correct `docs/specs/superset-embedded-dashboarding.md` R12/T8, which says Superset's metadata database is backed up and `backup.sh` is extended. D5 decided the opposite (2026-10-07). Also review the uncommitted edit to ADR-019 OQ-3 in this worktree: it still says Superset's database is backed up. |

---

## Rollback

- Superset-side code is inert until called; `owsub:` roles carry no permissions.
- Platform side: the migration has a down block; the enqueue sits behind `isSupersetStage2Enabled`, so unsetting `SUPERSET_OAUTH_CLIENT_ID` turns the feature off without a deploy.
- Erasure is irreversible by design; the job is idempotent, so a half-run is safe to repeat.

---

## Proposed plan-lock (NOT frozen)

For H3. Drafted (`approved: false`) with `.claude/hooks/write-plan.sh set -` on 2026-10-07; only the human's `approve-plan` stamps it. Amended 2026-10-07 before locking: T3 uses the chart CSV button, T11 and H7 dropped (no SQL Lab download), the row-cap task and criterion removed at the owner's request, statuses brought up to date. The `run-integration-tests.sh` verify commands do not exist until T1 is built.

```json
{
  "track": "3G reporting — Stage 2 gate: #728 plus #709, #716, #729, #731, ST17",
  "spec_ref": "docs/specs/superset-gdpr-erasure.md",
  "adr_refs": ["docs/decisions/ADR-019-reporting-tenant-isolation.md"],
  "acceptance_criteria": [
    {
      "id": "AC1",
      "text": "NullPool guard refuses a patched Superset source and a nullpool=False caller",
      "verify": "docker/superset/run-integration-tests.sh a"
    },
    {
      "id": "AC2",
      "text": "A real SQL Lab query and a real chart CSV export each write exactly one reporting.* audit row for the right tenant",
      "verify": "docker/superset/run-integration-tests.sh a"
    },
    {
      "id": "AC3",
      "text": "SQL Lab, chart and database counts match for staff, own-rows and second-tenant users",
      "verify": "docker/superset/run-integration-tests.sh a"
    },
    {
      "id": "AC4",
      "text": "Forged claim rejected; filter-dodging queries return 0 rows; export attributed to the right tenant; UUID username not stamped",
      "verify": "docker/superset/run-integration-tests.sh a"
    },
    {
      "id": "AC5",
      "text": "Per-user erasure leaves no personal data in Superset's DB or Redis cache",
      "verify": "docker/superset/run-integration-tests.sh b"
    },
    {
      "id": "AC6",
      "text": "Matching uses subject + tenant roles; protected accounts never erased; endpoint accepts only the service account",
      "verify": "docker/superset/run-integration-tests.sh b"
    },
    {
      "id": "AC7",
      "text": "FK coverage guard fails on an unclassified Superset user reference",
      "verify": "docker/superset/run-integration-tests.sh b"
    },
    {
      "id": "AC8",
      "text": "Login refreshes name and email; adds owsub exactly once",
      "verify": "docker/superset/run-integration-tests.sh b"
    },
    {
      "id": "AC9",
      "text": "Real route and real purge enqueue after commit; Superset down never blocks Postgres erasure; a cache-only job runs when Stage 2 is off",
      "verify": "pnpm test:isolation"
    },
    {
      "id": "AC10",
      "text": "Final failure writes one superset_erasure.failed row, success writes completed; an erasure with no completed row after 7 days alerts",
      "verify": "pnpm --filter @platform/worker test"
    },
    {
      "id": "AC11",
      "text": "Audit actions wired into every exhaustiveness map",
      "verify": "pnpm --filter @platform/audit test"
    },
    {
      "id": "AC12",
      "text": "Standalone spec T11 corrected; docs, CHANGELOG, week-log, ADR gate draft delivered",
      "verify": "pnpm typecheck && pnpm lint"
    }
  ],
  "scope_paths": [
    "docker/superset/**",
    "docker/observability/alert.rules.yml",
    "apps/api/src/routes/platform/users.ts",
    "apps/api/src/services/**",
    "apps/api/tests/isolation/**",
    "apps/worker/src/**",
    "apps/worker/tests/isolation/**",
    "packages/audit/**",
    "packages/config/**",
    "packages/db/migrations/**",
    "docs/**",
    ".claude/rules/db-conventions.md",
    "CHANGELOG.md"
  ]
}
```

Explicitly **not** in scope: `.github/workflows/**`, `docs/decisions/**`, and everything in spec §S0.

---

## Kick-Off Prompt

After H1–H3:

```
Read docs/specs/superset-gdpr-erasure.md and docs/specs/superset-gdpr-erasure-tasks.md.

Implement Phase A only (T1–T12), one task per commit, test first. T12 waits for T15.

Rules: no edits under apps/, packages/, modules/ in Phases A and B; never edit .github/workflows/ or
docs/decisions/; no personal data in payloads, logs or responses; write BLOCKERS.md on any ambiguity
in the classification table or when a test shows a real tenant leak.
```
