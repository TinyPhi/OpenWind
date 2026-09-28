# Roadmap tracker historical archive — 2026-08-24

`roadmap-tracker.md` was reworked on 2026-08-24 to drop fully-closed historical detail (same
pattern already used for `CLAUDE.md`'s hardening-checklist archive). Everything below is verbatim
content removed from the tracker at that point — all rows in it were already ✅ Closed/Done, kept
here only for historical reference. Nothing in this file is actionable; do not pick anything up
from it without re-verifying against `gh issue view` first.

---

### Phase 1 carry-overs — triaged 2026-05-22 (full table)

| Issue                     | Title                                           | Decision                                                                                                                                                                                                                                                                                    | Gate |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [#3](../../../issues/3)   | Workflow reliability gaps (tracker)             | ✅ Closed — items 1–3 done (#59–61), item 4 tracked in #62                                                                                                                                                                                                                                  | —    |
| [#64](../../../issues/64) | Transition rollback / undo policy               | ✅ Closed — Option A: irreversible by design, ADR-002 WE-02 resolved, `engine.ts` comment added                                                                                                                                                                                             | —    |
| [#2](../../../issues/2)   | SSRF + PII leakage gaps                         | ✅ Closed — PR #85; SSRF block + PII redaction + cross-tenant ref guard                                                                                                                                                                                                                     | —    |
| [#5](../../../issues/5)   | Tenant lifecycle + audit log + outbox retention | ✅ Closed — PR #86; lifecycle service, purge worker, audit entries                                                                                                                                                                                                                          | 2A   |
| [#62](../../../issues/62) | Workflow version GC + stuck instance recovery   | ✅ Closed 2026-08-02 — premise didn't match shipped architecture (no workflow versioning exists; `deleteWorkflow` already blocks on any instance). Real analogous gap split into #301 (`deleteWorkflowState` didn't check for live instances in the state) and fixed same session, PR #302. | —    |

(#4 and #65 remain open/deferred — see the current tracker's Deferred/Open Tickets tables, not this archive.)

---

### Phase 2 sub-items (module seeds) — full detail

| Module                  | Category (ADR-005) | Entity types                        | Workflow                                        | Status                                                                         |
| ----------------------- | ------------------ | ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| @modules/helpdesk       | core               | Ticket, Comment, Article            | Open → In Progress → Pending → Resolved + SLA   | ✅ Done                                                                        |
| @modules/reimbursements | core               | Expense Claim, Receipt              | Draft → Submitted → Mgr Review → Finance → Paid | ✅ Done                                                                        |
| @modules/crm            | core               | Contact, Company, Deal, Activity    | Lead → Qualified → Proposal → Won/Lost          | ✅ Done                                                                        |
| @modules/projects       | core               | Project, Task, Milestone            | Backlog → In Progress → In Review → Done        | ✅ Done                                                                        |
| @modules/hrms           | core               | Employee, Department, Leave Request | Draft → Submitted → Approved/Rejected           | ✅ Done                                                                        |
| @modules/invoicing      | core               | Invoice, Quote, Payment             | Draft → Sent → Paid/Overdue/Cancelled           | ✅ Done                                                                        |
| @modules/procurement    | core               | Purchase Order, Vendor, RFQ         | Draft → Approved → Sent → Fulfilled             | ✅ Done                                                                        |
| @modules/tender         | optional (ADR-005) | Tender                              | Draft → BOQ → Costing Review → Docs → Submitted | ✅ Done — `modules.category` column shipped PR #342 (2026-08-06), closing #165 |

`tender` was shipped (PR #144, 2026-07-16) and formally ratified as the platform's 8th module by
ADR-005 (accepted 2026-07-23).

### Per-workflow ownership/admin model (PR #155) — ratified, full detail

ADR-006 (accepted 2026-07-24) formally adopts the per-workflow ownership/admin authorization model
PR #155 shipped 2026-07-21 as **permanent, accepted policy**. Its own follow-up items:

- **Closed:** `grant-access.ts` didn't accept workflow-admin callers the same way
  `resolve-access-request.ts` does — filed as #167, closed via PR #179 (2026-07-24).
- **Deferred, tracked:** transition guards not consulting per-instance `__accessUsers` grants — an
  accepted v1 limitation per `docs/specs/tender-management.md`, not yet its own issue.
- **RLS for the four workflow-config tables** — spun out as its own ADR-007 (accepted 2026-07-24,
  merged via PR #181 on 2026-07-25) rather than folded into ADR-006.

---

### Pre-Phase-3 hardening backlog — full detail (all closed)

Originally surfaced by an external consulting review (2026-06-29); the review docs themselves
were consolidated into `docs/reviews/pending-review-findings.md` 2026-07-24.

| Issue                       | Title                                                               | Status                                                                       |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [#121](../../../issues/121) | RLS under real role (`SET LOCAL ROLE app_user`)                     | ✅ Closed — PR #135                                                          |
| [#122](../../../issues/122) | Isolation tests run as `app_user`, not superuser                    | ✅ Closed — alongside #121                                                   |
| [#126](../../../issues/126) | `entity.created`/`entity.assigned` triggers never fire              | ✅ Closed — PR #138                                                          |
| [#127](../../../issues/127) | `setEntityState`/`bulkSetState` unguarded state side-door           | ✅ Closed — PR #155                                                          |
| [#120](../../../issues/120) | Automation double-trigger (depth resets on outbox path)             | ✅ Closed                                                                    |
| [#123](../../../issues/123) | Automation queue has no retries                                     | ✅ Closed                                                                    |
| [#124](../../../issues/124) | Auth middleware writes on every request                             | ✅ Closed                                                                    |
| [#128](../../../issues/128) | OpenBao + MinIO commented out of docker-compose                     | ✅ Closed — PR #173 (2026-07-23), idempotency follow-up PR #178 (2026-07-24) |
| [#129](../../../issues/129) | Worker has no health endpoint                                       | ✅ Closed — PR #175 (2026-07-24)                                             |
| [#141](../../../issues/141) | `pnpm lint` is a repo-wide no-op                                    | ✅ Closed — PR #166                                                          |
| [#136](../../../issues/136) | RLS for entity_types/workflows/workflow_states/workflow_transitions | ✅ Closed — ADR-007 accepted, merged via PR #181 (2026-07-25)                |
| [#125](../../../issues/125) | `notify` action — outbox-pattern delivery worker + in-app inbox     | ✅ Closed — PR #211 (2026-07-29)                                             |

#### Security hardening — July 2026 audit batch (filed 2026-07-31, issues #221–#267)

| Group | PR   | Issues fixed                                                        | Status               |
| ----- | ---- | ------------------------------------------------------------------- | -------------------- |
| A     | #281 | #237, #262, #255, #238, #232, #236                                  | ✅ Merged 2026-07-31 |
| B     | #279 | #225, #223, #229, #231                                              | ✅ Merged 2026-07-31 |
| C     | #280 | #224, #239, #235, #240, #241                                        | ✅ Merged 2026-07-31 |
| —     | #282 | #201 (native confirm/alert)                                         | ✅ Merged 2026-07-31 |
| E     | #283 | #243, #244, #254, #234                                              | ✅ Merged 2026-07-31 |
| F     | #270 | #266                                                                | ✅ Merged 2026-07-31 |
| G     | #293 | #245, #228, #258, #256, #259, #257                                  | ✅ Merged 2026-08-01 |
| D     | #305 | #226, #227, #230, #233, #249, #264, #265                            | ✅ Merged 2026-08-03 |
| H     | #294 | #251, #252, #253, #260, #261, #263                                  | ✅ Merged 2026-08-01 |
| —     | #312 | #306, #308, #309, #310, #311 (Group D + workflow-engine follow-ups) | ✅ Merged 2026-08-03 |
| —     | —    | #246, #248, #250, #247                                              | ✅ All 4 closed      |

#### Found since the 2026-06-29 consulting review, closed

| Issue                                                                                 | Title                                                                        | Status                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| [#168](../../../issues/168)                                                           | Shadow-workflow entity-type-ownership escalation                             | ✅ Closed — PR #172            |
| [#170](../../../issues/170)                                                           | `installModule`'s `workflowName` rename dead for non-templated seed files    | ✅ Closed — PR #174            |
| [#167](../../../issues/167)                                                           | `grant-access.ts` should accept workflow-admin callers                       | ✅ Closed — PR #179            |
| [#160](../../../issues/160)                                                           | `setEntityState`/`bulkSetState` don't validate target state                  | ✅ Closed — PR #180            |
| [#176](../../../issues/176)                                                           | Guardrail hooks: shared state clobbers across branches; worktree bypass      | ✅ Closed — PR #177            |
| [#171](../../../issues/171)                                                           | helpdesk's redundant non-idempotent `001_seed.sql`                           | ✅ Closed — PR #188            |
| [#182](../../../issues/182)–[#185](../../../issues/185)                               | Nit-bugs from PR #175/#177/#179/#180 reviews                                 | ✅ Closed — PR #186            |
| [#187](../../../issues/187)                                                           | `TRANSITION_LOCKED` falls through to 500 in `handle-workflow-error.ts`       | ✅ Closed — PR #188            |
| [#150](../../../issues/150), [#148](../../../issues/148), [#110](../../../issues/110) | Small housekeeping (gitignore, corepack hash, pretest script)                | ✅ Closed — PR #188            |
| [#143](../../../issues/143)                                                           | Automation-triggered transitions absent from outbox (Phase 3A connector gap) | ✅ Closed — PR #372, #378/#379 |
| —                                                                                     | `outbox_events`/`dead_letter_events` RLS null-GUC cast breaks batch pollers  | ✅ Closed — PR #374            |

---

### Second consulting-review batch (#191–#202) — full detail

Filed 2026-07-24 from the second external consulting-review pass.

| Issue                       | Title                                                                  | Status                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [#191](../../../issues/191) | Automation `assign`/`create_entity` actions declared, never dispatched | ✅ Closed — PR #219                                                                                                  |
| [#195](../../../issues/195) | Rate limiter bucketed on unverified JWT claim, not tenant              | ✅ Closed — PR #221                                                                                                  |
| [#218](../../../issues/218) | `create_entity` unbounded recursion (follow-up from #191)              | ✅ Closed — PR #270                                                                                                  |
| [#220](../../../issues/220) | `loadEntityType()` no explicit tenant filter (follow-up from #191)     | ✅ Closed — PR #222                                                                                                  |
| [#149](../../../issues/149) | 4 pre-existing `view-configs.test.ts` failures under parallelism       | ✅ Closed — PR #269                                                                                                  |
| [#196](../../../issues/196) | Scale-risk backlog — cache invalidation, pagination, N+1, pool         | ✅ Closed 2026-08-01 — pool ceiling split into #296 (still open, see current tracker)                                |
| [#201](../../../issues/201) | Native `confirm()`/`alert()` instead of a shared dialog                | ✅ Closed — PR #282                                                                                                  |
| [#194](../../../issues/194) | `tests/e2e/` has no actual test harness                                | ✅ Closed 2026-08-02 — PR #287                                                                                       |
| [#197](../../../issues/197) | "Configured" field types render as plain text, not real widgets        | ✅ Closed — PR #288 (`file`/`files` deferred as #289)                                                                |
| [#289](../../../issues/289) | `file`/`files` field-type widgets deferred from #197/PR #288           | ✅ Closed — PR #299                                                                                                  |
| [#199](../../../issues/199) | `packages/ui` is hollow — no real shared component library             | ✅ Closed 2026-08-06 — Dialog/AlertDialog, FieldInput, Button/IconButton, Table primitive, design tokens all shipped |
| [#202](../../../issues/202) | `docker compose down -v` data-loss foot-gun                            | ✅ Closed                                                                                                            |

(#192, #198, #200 remain open — see the current tracker's Open Tickets table, not this archive.)
