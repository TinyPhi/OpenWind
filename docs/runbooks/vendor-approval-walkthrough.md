# Vendor approval live walk-through (#691 / T12)

Owner: @abmish (assignee on #691: @TusharSharma991). Use it when closing the T12 gap recorded in
[docs/specs/vendor-approval.md](../specs/vendor-approval.md) §B: a real Zitadel login, the admin-ui and
`ow-worker` exercised end to end for the `vendor-approval` module (3H Phase 1).
Design context: [ADR-020](../decisions/ADR-020-module-ownership-model.md) (proposed), module README
[modules/vendor-approval/README.md](../../modules/vendor-approval/README.md), segregation rules in
[docs/specs/segregation-of-duties.md](../specs/segregation-of-duties.md) (#1009).

This replaces the walk-through comment posted on #691 on 2026-10-02. That version predates three changes and
is wrong in these places:

- **Admin is not on the review transitions any more.** The seed (`002_workflow.sql`) gives each review
  transition `allowed_roles` of the single department role, plus `actor_not_creator` and
  `actor_not_prior_actor`. `owAdmin` sees no working buttons on review states; it can only use the recorded
  state override. The old "owAdmin sees every stage's buttons" row is false.
- **There is no "action bar".** The admin-ui shows a **State** dropdown ("Move to...") on the record detail page.
  The old step 4 table described buttons that do not exist, and the UI does not hide anything by role (see Gap 1).
- **Bootstrap has no manual PAT step.** `setup.sh` / `setup.bat` generate the PAT headlessly
  ([docs/local-setup.md](../local-setup.md)).

Mark every step PASS or FAIL. A step marked **(unverified)** was written from code reading and has not been run.
Everything else was checked against the code at `0542b6e` (2026-10-31).

## 0. Prerequisites

- Docker (OrbStack on macOS), a checkout at current `main`, no half-bootstrapped state.
- Browser with one private window per user so sessions do not mix.
- A terminal in the repo root for the SQL and Redis checks (container names: `ow-database`, `ow-cache`,
  `ow-backend`, `ow-worker`).

## 1. Build, start, bootstrap

```bash
./setup.sh                       # Linux/Mac; setup.bat on Windows. Fully automated, no manual PAT.
docker compose build ow-backend ow-worker && docker compose up -d
```

If the stack was already bootstrapped, `pnpm bootstrap` is idempotent and can be re-run
([docs/local-setup.md](../local-setup.md) step 4); it must be run with the Zitadel PAT/key the way `setup.sh` does.

- [ ] **1a.** Bootstrap output ends with the "Done" banner and has a "Vendor Approvers" block listing
      `itSecurity / legal / financeApprover` (`scripts/bootstrap.ts:1304-1306`), with no failure lines.
- [ ] **1b.** Roles exist in the Zitadel project, group `department` (`scripts/bootstrap.ts:631-643`):
      `it_security`, `legal`, `finance_approver`, next to `admin`, `agent`, `user`.
      Check in the Zitadel console: Projects -> the platform project -> Roles.
- [ ] **1c.** On a re-run against an already-bootstrapped stack there is no warning about existing users or
      grants (#682, fixed in #747). **(unverified in this pass)**

Logins (password `OpenWind1234!`, `DEMO_PASSWORD` in `scripts/bootstrap.ts:99`):

| user              | roles                   | role in this walk-through                               |
| ----------------- | ----------------------- | ------------------------------------------------------- |
| `owAdmin`         | admin                   | installs the module, creates the vendor (the requester) |
| `itSecurity`      | agent, it_security      | decides IT Security Review                              |
| `legal`           | agent, legal            | decides Legal Review                                    |
| `financeApprover` | agent, finance_approver | decides Pending Final Approval                          |

Zitadel roles are the roles claim of the access token; the API maps them straight to `auth.roles`
(`packages/auth/src/jwks.ts:288`). Bootstrap sets `accessTokenType: JWT` and `accessTokenRoleAssertion: true`
(`scripts/bootstrap.ts:709-711`).

## 2. Install the module

The requester must not be an approver (`actor_not_creator`), so install and create as `owAdmin`.

- [ ] **2a.** As `owAdmin`, open **Templates** (sidebar; page title "Module Templates"). If the list is empty,
      click **Seed Templates** (calls `POST /modules/seed`, admin only).
- [ ] **2b.** Find **Vendor Approval**, click **Copy Template**, accept or change the workflow name
      (default is the module name, since `vendor-approval` is not in `MODULE_DEFAULT_NAMES`,
      `apps/admin-ui/src/pages/modules.tsx:39-47`), confirm **Copy Template**. Expected: modal closes with no error
      (`POST /modules/vendor-approval/install` -> 201, admin only, `apps/api/src/routes/modules/index.ts:56`).
- [ ] **2c.** Seed result, from the database:

```bash
docker exec ow-database psql -U platform -d platform -c "
  select t.from_state, t.to_state, t.label, t.allowed_roles, t.requires_comment, t.requires_fields
  from workflow_transitions t join workflows w on w.id = t.workflow_id
  join entity_types e on e.id = w.entity_type_id where e.name = 'vendor' order by t.sort_order;"
```

Expected: 7 rows. `draft -> it_security_review` has roles `{agent,admin}` and required fields
`{contact_email,annual_spend_estimate,business_justification,security_questionnaire}`. Each review transition has
exactly one department role (`it_security`, `legal`, `finance_approver`); the three `Reject` rows have
`requires_comment = t`; `Approve Legal` requires `{contract_draft}`. No review transition lists `admin`.

Alternative (fixtures at every state): `docker compose exec ow-backend pnpm exec tsx apps/api/src/scripts/vendor-approval-demo.ts`.
Do not use it for the live walk-through itself; it drives transitions through the engine, not the UI.

The three seeded notify rules are installed **disabled** with no recipient (`003_automation_rules.sql`).
No notification is expected anywhere in this walk-through unless you enable them in Automations.

## 3. Department role is in each approver's JWT

For each of `itSecurity`, `legal`, `financeApprover`, log in (private window) and run in the DevTools console
(oidc-client-ts stores the user in `localStorage`, `apps/admin-ui/src/authProvider.ts:43`):

```js
const k = Object.keys(localStorage).find((k) => k.startsWith("oidc.user:"));
const t = JSON.parse(localStorage[k]).access_token;
const claims = JSON.parse(
  atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
);
Object.keys(claims["urn:zitadel:iam:org:project:roles"] ?? {});
```

- [ ] **3a.** `itSecurity` -> `["agent","it_security"]`
- [ ] **3b.** `legal` -> `["agent","legal"]`
- [ ] **3c.** `financeApprover` -> `["agent","finance_approver"]`

Do not paste tokens into jwt.io or any external site. The roles list must contain `agent` too: the entity routes
need `admin|agent|user` and admin-ui treats everyone else as a customer.

## 4. Create a vendor and submit it (as `owAdmin`)

- [ ] **4a.** **Records** -> the vendor workflow card -> **New Vendor** (`workflow-records.tsx:1905`). Fill
      Title, Vendor Name, Category (required by the entity type), Contact Email, Annual Spend Estimate,
      Business Justification, and upload a Security Questionnaire. Save. Expected: record appears in state **Draft**.
- [ ] **4b.** Open the record. State dropdown shows exactly one option, **Submit for IT Security Review**
      (the only transition out of `draft`). Choose it. Expected: state becomes **IT Security Review**, no error.
      If a required field is empty the API answers 422 `REQUIRED_FIELDS_MISSING` with the field names; the UI
      shows the message in the record page's transition error banner (`transError`). **(UI wording unverified)**
- [ ] **4c.** Evidence rows, right after 4b:

```bash
docker exec ow-database psql -U platform -d platform -c "
  select from_state, to_state, triggered_by, actor_id, comment, created_at
  from workflow_events order by created_at desc limit 3;
  select event_type, payload->>'fromState' f, payload->>'toState' t, delivered_at
  from outbox_events where event_type in ('workflow.transitioned','workflow.sla_scheduled')
  order by created_at desc limit 4;"
```

Expected: a `workflow_events` row `draft -> it_security_review`, `triggered_by = user`, `actor_id` = owAdmin's
Zitadel user id; an outbox `workflow.transitioned` row for it; and one `workflow.sla_scheduled` row (see step 7).
(Run the two selects separately if your psql refuses two statements with `-c`.)

## 5. Who may act at each stage

The server is the authority (`executeTransition`, `packages/workflow-engine/src/engine.ts:445-505`): the
transition must leave the current state; the actor must hold one of `allowed_roles` (else 403
`TRANSITION_FORBIDDEN`); the segregation conditions must hold (else 422 `CONDITION_NOT_MET`); required fields
(422 `REQUIRED_FIELDS_MISSING`); required comment (422 `REQUIRED_FIELDS_MISSING`, fields `["comment"]`).

Expected **server** behaviour by user and state (what the engine will allow; and what
`GET /entities/:id/transitions` returns, which filters by role and conditions):

| state                  | `itSecurity`                        | `legal`                       | `financeApprover`                | `owAdmin` (creator) |
| ---------------------- | ----------------------------------- | ----------------------------- | -------------------------------- | ------------------- |
| IT Security Review     | Approve Security, Reject (Security) | none                          | none                             | none                |
| Legal Review           | none                                | Approve Legal, Reject (Legal) | none                             | none                |
| Pending Final Approval | none                                | none                          | Approve Vendor, Reject (Finance) | none                |

Expected **UI** behaviour today: **the State dropdown lists every transition out of the current state to every
agent or admin**, regardless of role or segregation rules (Gap 1). So in this step each cell marked "none" will
show the options in the dropdown, and choosing one will return the error in the right column of the next table.
Record whatever you see in the "UI shows" column. A UI that hides the wrong options would be a PASS for the
design intent but is **not** what the code does today.

- [ ] **5a.** In **IT Security Review**, as `legal`: UI shows (expected today) "Approve Security" and
      "Reject (Security)"; choosing "Approve Security" fails with 403 `TRANSITION_FORBIDDEN`
      ("You do not have permission to perform this transition"). Record stays in IT Security Review.
- [ ] **5b.** Same, as `financeApprover`: same result.
- [ ] **5c.** Same, as `owAdmin`: same result (403). Admin is not allowed on review transitions.
- [ ] **5d.** (Segregation, requester) Create a second vendor as `itSecurity` and submit it (an agent may
      submit). As `itSecurity`, choose Approve Security. Expected: 422 `CONDITION_NOT_MET` ("Transition conditions
      not met"); state unchanged. A different `it_security` holder is needed to move it on; use `owAdmin`'s
      state override (below) to clean it up, or leave it.
- [ ] **5e.** Sanity on the per-user offer list: `GET /entities/<id>/transitions` with each user's token
      returns exactly the table's row for that user (the API call the admin-ui does not make).

## 6. Walk Draft to Approved; rejects need a comment

Use the vendor from step 4 (state IT Security Review).

- [ ] **6a.** `itSecurity` -> **Approve Security**. Expected: **Legal Review**. `workflow_events` gains
      `it_security_review -> legal_review`, `actor_id` = itSecurity.
- [ ] **6b.** `legal` -> **Approve Legal** before attaching a contract: Expected 422
      `REQUIRED_FIELDS_MISSING`, `fields: ["contract_draft"]`. Attach a Contract Draft to the record (as `legal`;
      **whether an agent who did not create the record may edit fields is unverified**, fall back to `owAdmin`
      attaching it), then **Approve Legal**. Expected: **Pending Final Approval**.
- [ ] **6c.** `financeApprover` -> **Approve Vendor**. Expected: **Approved** (terminal). Dropdown is now
      disabled with title "No transitions available".
- [ ] **6d.** Four actors, three decisions: `select actor_id, from_state, to_state from workflow_events` for the
      record shows owAdmin, itSecurity, legal, financeApprover in order, all `triggered_by = user`.
- [ ] **6e.** (Reject path) New vendor as `owAdmin`, submit. As `itSecurity`, choose **Reject (Security)**:
      UI opens a comment modal with the confirm button disabled until text is entered
      (`record-detail.tsx:6571`, `6596`). Enter a comment, confirm. Expected: **Rejected** (terminal);
      `workflow_events.comment` holds the text.
- [ ] **6f.** Server-side comment rule, bypassing the UI:

```bash
curl -s -X POST "$API/entities/<id>/transitions" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"transitionId":"<reject-transition-id>"}'
```

Expected 422 `REQUIRED_FIELDS_MISSING`, `fields: ["comment"]`. Repeat the reject path at Legal and Finance
once each (use a fresh vendor per stage).

- [ ] **6g.** (Override, optional) A vendor stuck in a review state: as `owAdmin` (not the record's creator,
      so create the vendor as another user), the record page offers the state override
      (`record-detail.tsx:1736-1742`; workflow ships `allow_state_override = true`). A reason is required
      (`OVERRIDE_REASON_REQUIRED`). Expected: state moves, an admin-audit entry is written, and the workflow
      event is flagged `override`. **(unverified)**

## 7. 48h SLA events and the worker

Each of the three review states carries `sla_hours = 48`; draft and terminal states carry none
(`002_workflow.sql`). On entering a state the engine writes one `workflow.sla_scheduled` outbox row
(`engine.ts:797-835`); on leaving, `cancelPendingSlaTimers` marks the still-undelivered rows for the left state
as delivered (`engine.ts:772-795`).

Run right after a vendor enters a review state, before advancing it:

```bash
docker exec ow-database psql -U platform -d platform -c "
  select id, payload->>'stateName' state, payload->>'slaHours' hours,
         payload->>'fireAt' fire_at, created_at, delivered_at
  from outbox_events where event_type = 'workflow.sla_scheduled'
  order by created_at desc limit 5;"
```

- [ ] **7a.** One row per review-state entry: `state` is the entered state, `hours = 48`, `fire_at` = entry time
  - 48h (to the second).
- [ ] **7b.** Within about 10 s (`DEFAULT_POLL_INTERVAL_MS`, `apps/worker/src/sla-scheduler.ts:50`)
      `delivered_at` is set **because the scheduler enqueued the job**, not because anything was processed. Do not read
      `delivered_at` as proof either way on its own. `docker compose logs ow-worker` shows
      `SLA scheduler: enqueued breach jobs`.
- [ ] **7c.** The delayed job exists (use the `id` from 7a; queue name `sla`, job id `sla:<outbox id>`):

```bash
docker exec ow-cache redis-cli ZSCORE bull:sla:delayed "sla:<id>"
```

Expected: a numeric score (BullMQ encodes the due time in the high bits, so it is not a plain epoch value;
check the job's delay in Bull Board instead if you need the time: `docker compose --profile tools up -d bullboard`,
http://localhost:3099, queue `sla`). **(score format unverified)**

- [ ] **7d.** Cancellation, two cases. (i) Advance a vendor **within 10 s of entering a state**, before 7b has
      happened: the row's `delivered_at` is set by the transition and no job is ever enqueued. (ii) Advance it
      **after** the job was enqueued: the row is already delivered (so the transition changes nothing), the BullMQ job
      stays in `sla:delayed`, and at fire time `sla-breacher` finds `current_state != stateName` and logs
      `SLA breach: instance already transitioned - skipping` with no `workflow.sla_breached` row
      (`apps/worker/src/sla-breacher.ts`). The old runbook's "leaving a state cancels the Redis job" is wrong for (ii).
- [ ] **7e.** Breach path. 48 hours is too long to wait; an approximation, **(unverified)**: promote the delayed
      job to run now from Bull Board (queue `sla`, delayed tab, job `sla:<id>`, Promote) while the vendor is still in
      that state. Expected: `ow-worker` logs `SLA breach: outbox event written` and an outbox row
      `workflow.sla_breached` appears with `payload->>'state'` = the review state and `slaHours = 48`.
      Promote a job for a vendor that has already moved on and confirm the "already transitioned" log and no new row.
- [ ] **7f.** The breach is consumed by the outbox poller (2 s) for automation triggers; with the seeded notify
      rules disabled, nothing is sent. Not a walk-through failure.

## 8. Report

Post on #691 PASS/FAIL per numbered step with a screenshot of the State dropdown per role at each stage (so
Gap 1 is evidenced), the 7a query output, and bug links. Then record "T12 PASS" + date in
`docs/specs/vendor-approval.md` §B in a small PR.

## Known gaps likely to surface

Findings below are from code reading on `0542b6e`; confirm against the live stack when you run steps 5 and 7.
None is fixed by this runbook.

### Gap 1 - admin-ui offers transitions the user cannot take (confirmed in code)

The record-detail State dropdown filters only by `fromState` and never by role or conditions:

- `apps/admin-ui/src/pages/customer/record-detail.tsx:965` `transitions.filter((t) => t.fromState === current)`.
- The `Transition` type the UI holds has no `allowedRoles` or `conditions` (`record-detail.tsx:125-131`).
- It loads transitions from `GET /workflows/:id` (`record-detail.tsx:2907`), which returns the full transition
  list to every `admin|agent|user` caller (`apps/api/src/routes/workflows/get.ts`, `workflow-crud.ts:156-198`).
- The role- and segregation-aware endpoint `GET /entities/:id/transitions` exists
  (`apps/api/src/routes/entities/list-transitions.ts`, `engine.ts:618-678`) but admin-ui never calls it:
  the only `/transitions` calls in admin-ui are `POST` (`record-detail.tsx:3209`, `workflow-records.tsx:1127`).
- The only gate is `canChangeState` = admin/agent/workflow-admin, or the creator or assignee (`record-detail.tsx:1815-1818`).
  Every approver has `agent`, so every approver sees every option.
- The kanban drop target has the same weakness: `workflow-records.tsx:415-417` allows a drop if any transition
  exists between the two states.

Effect: the "hide Approve/Reject from users without the role" behaviour in the module README
("A user without the stage's department role doesn't see that stage's buttons") is not what the UI does. It is a
usability and confusion issue, not an authorisation hole: the engine refuses with 403/422
(`engine.ts:464-492`). The same is true for the requester, who is offered Approve and gets
`CONDITION_NOT_MET`. Suggested fix direction (not done): have the record page call
`GET /entities/:id/transitions` and render that.

### Gap 2 - segregation of duties: a workflow admin cannot clear an actor rule, but can route around it

Asked: can a workflow admin who is not a tenant admin clear a transition's actor rule? **The literal path is closed**
and is gated on the server by #1008:

- `apps/api/src/lib/sod-rule-gate.ts:35-46` `assertMaySetActorRules` throws unless `isPersonAdmin`
  (global `admin`, and not an API key, `sod-rule-gate.ts:16-18`) when the write adds, changes or removes an
  `actor_*` condition. It is called from create (`create-transition.ts:42`), update
  (`update-transition.ts:57-63`), delete (`delete-transition.ts`), canvas save (`canvas.ts`) and workflow
  delete (`delete.ts`); the refusal is a 403 `FORBIDDEN` (`update-transition.ts:114-116`).
  Changes to conditions are audited (`workflow.transition_conditions_updated`, `update-transition.ts:94-109`).

But a non-admin **workflow admin** (a workflow's `created_by` or `assigned_to`, `assertWorkflowOwned`,
`workflow-crud.ts:527-552`) can still weaken the control without touching an actor condition, because the gate
only inspects `conditions`:

- **2a. Add an unguarded parallel edge (full bypass).** `POST /workflows/:id/transitions` with the same
  `fromState`/`toState`, e.g. `it_security_review -> legal_review`, `allowedRoles: ["agent"]`, no `conditions`:
  `assertMaySetActorRules(auth, null, null)` returns at `sod-rule-gate.ts:42` (no rule on either side);
  `addWorkflowTransition` (`workflow-crud.ts:928-960`) inserts it, and `workflow_transitions` has no unique
  index on (workflow, from, to) (`packages/db/src/schema/workflow-engine.ts:91-118`). Any agent, including the
  requester, can then take that edge. The spec already lists this as a known limit
  (`docs/specs/segregation-of-duties.md` §K, "Two transitions between the same pair of steps"), but the write
  gate does not stop it.
- **2b. Widen `allowed_roles` on a ruled transition (loses department gating, keeps creator/prior-actor rules).**
  `PATCH` with `allowedRoles: ["agent"]` and no `conditions` key: the gate is skipped
  (`update-transition.ts:57`, `input.conditions === undefined`) and `updateWorkflowTransition` applies it
  (`workflow-crud.ts:975-976`). Audited as `workflow.transition_roles_updated`, but not blocked.
- **2c. Canvas save** accepts `allowedRoles` per transition (`canvas.ts:40`, `241-318`); same reasoning, only
  conditions are gated. **(unverified beyond reading)**

Treat 2a as the segregation-of-duties gap to file. Try it in step 5 if you have a non-admin workflow admin;
the seed makes `owAdmin` (the installer) the workflow's owner, so assign a second user as workflow admin first.
**(the live repro is unverified)**

### Gap 3 - other things likely to surface

- Notify rules are disabled with no recipient; nobody is notified on stage entry (module README, #607).
- `execute-transition.ts` (the `POST` route) does not apply the entity-access check that the transitions list
  does (`list-transitions.ts` checks `hasEntityAccess`); every approver has `agent`, so it is moot here, but see
  ADR-006 for the access-grant gap. **(unverified impact)**
- Installs made before #1009 keep the old transitions (admin can still decide). If you reuse an old dev tenant,
  step 2c will show `admin` in `allowed_roles`; reset or edit the transitions on the canvas.
- Do not re-seed a tenant with live vendors (`modules/vendor-approval/README.md` section 3).
