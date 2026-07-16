# Ticket Relations, Hierarchy & Access Control — Design Reference

> **Date:** 2026-06-26
> **Status:** Design and implementation reference — sections 1–9 are analysis; section 10 is the implementation spec
> **Scope:** Linked tickets, parent-child hierarchy, parallel/causal relations, @mention access, child workflow states

---

## 1. The Problem Space

The current helpdesk module has no way to link related tickets. When complex work is split across agents, admins create entirely separate, unlinked tickets — breaking context continuity, causing duplicated effort, preventing progress rollup, and forcing re-entry of the same context into every ticket.

| Scenario                                     | Relation needed              |
| -------------------------------------------- | ---------------------------- |
| Complex work split across agents             | Parent → children            |
| Ticket B can't start until ticket A resolves | `blocks` / `blocked_by`      |
| Ticket B exists because ticket A happened    | `causes` / `caused_by`       |
| Tag a colleague for their input              | @mention → read access grant |
| Same underlying issue                        | `duplicates`                 |
| Vague cross-reference                        | `relates_to`                 |

---

## 2. What the Codebase Already Has

### 2.1 `entity_relations` table

```
entity_relations
  id               UUID PK
  tenant_id        UUID NOT NULL
  from_instance_id UUID FK → entity_instances
  to_instance_id   UUID FK → entity_instances
  relation_type    TEXT NOT NULL
  created_at       TIMESTAMPTZ
  deleted_at       TIMESTAMPTZ     -- NULL = active; set on soft-delete of either endpoint ticket
```

API endpoints for creating, listing, and deleting relations already exist. What is missing: typed relation semantics, access control that reads these relations, and a participants mechanism for @mentions.

### 2.2 Current access model

`entity_instances.assigned_to` is a single Zitadel user ID. Access is binary: you are the assignee or you are an admin/agent who sees everything. No per-ticket participant list exists today.

Access is enforced at two layers: RLS (`app.tenant_id` GUC) and explicit `WHERE tenant_id = ?` in every engine query. Issue #121 means `SET LOCAL ROLE app_user` is never called, so RLS is currently unenforced for the connection role — the explicit filter is the sole active defence.

---

## 3. Industry Reference

### 3.1 Jira

3-level Epic → Story → Subtask hierarchy. Security levels propagate downward to true Subtask types only — child assignees do not get parent visibility automatically. JRASERVER-5869 (child assignee cannot read parent) has been open since 2014 and was marked Won't Fix. @mention sends a notification but grants no access; users get notifications for tickets they cannot open.

### 3.2 ServiceNow

Parent incident → child incident_task. ACL inheritance follows table schema hierarchy, not record relationship hierarchy. Being assigned to an `incident_task` grants zero automatic access to its parent `incident`. Cross-record visibility requires custom GlideRecord scripting most deployments skip. Broad `itil` role grants access to everything instead.

### 3.3 Linear

Sub-issues inherit team/project from the parent; access is team-level only, no per-issue security. **Best-in-class @mention security:** blocks the @mention at input time if the user lacks team access. Most secure, but treats @mention as a capability assertion rather than an access request.

### 3.4 GitHub Sub-issues

8 levels of depth, no per-issue security. Access is entirely repo-level. Blocking reached GA August 2025 as advisory-only — no transition enforcement. **Ghost notification bug:** notification badge fires regardless of access; the recipient is notified about an issue they cannot open. Worst @mention outcome in the industry.

### 3.5 Zendesk

Flat model with 1-to-many linked tickets; no semantic hierarchy. Group-based access: all agents in a group see all tickets in it. @mention triggers a notification but grants no access if the agent lacks group membership — silent failure with no feedback. Auto-resolving children when parent resolves causes incorrect closures; most teams disable it. **Lesson:** when the access unit is a group, all access-control problems push upstream to group management and don't scale.

### 3.6 Freshdesk

Flat ticket model, group-based access. **Best-in-class @mention UX:** when a mentioned user lacks group membership, Freshdesk surfaces an explicit "Grant access?" dialog before the comment is saved. The mentioner makes a conscious decision. **Limitation:** once granted, access has no expiry, no revocation UI, and no per-participant audit trail. The dialog solves accidental grants without solving zombie access or audit trail problems.

### 3.7 Parallel dependencies (AND-gates)

No mainstream system enforces AND-gate logic natively for manual ticket transitions. ClickUp shows a dismissable warning. ServiceNow Flow Designer has true AND-gates for automated workflow branches only.

---

## 4. Relation Type Taxonomy

| Relation type                  | Inverse            | Semantic                                                      | Enforcement                                            |
| ------------------------------ | ------------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| `parent_of` / `child_of`       | Each other         | Strict hierarchy; child belongs to exactly one parent         | Access propagation, one-parent constraint, depth limit |
| `blocks` / `blocked_by`        | Each other         | The blocked ticket cannot progress until the blocker resolves | Optional workflow transition condition                 |
| `causes` / `caused_by`         | Each other         | Root-cause documentation                                      | Informational only                                     |
| `duplicates` / `duplicated_by` | Each other         | Same underlying issue                                         | Informational; automation hook                         |
| `relates_to`                   | Itself (symmetric) | General cross-reference                                       | Informational only                                     |

**One-parent constraint:** A ticket may have at most one `child_of` relation. All other types are unconstrained.

**Depth limit:** `parent_of` chains are bounded at either 3 or 5 levels — exact number is **open question 3**, pending human sign-off. Enforced at relation-creation time by counting the existing chain depth before accepting the new `child_of`.

**Cycle detection** is required for `parent_of` and `blocks` (enforcement types). `causes` and `relates_to` cycles carry no system consequence — a soft warning is sufficient.

**Relation lifecycle:**

| Relation type                  | On `from` soft-delete                                      | On `to` soft-delete           | On re-parent                                         | On resolution                                              |
| ------------------------------ | ---------------------------------------------------------- | ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `parent_of` / `child_of`       | Block if active children exist; force-delete orphans child | Same                          | Revoke old / derive new ancestor participant records | No automatic effect                                        |
| `blocks` / `blocked_by`        | Remove relation; previously blocked ticket unblocked       | Remove relation; blocker gone | Relation survives                                    | Remove if resolving ticket is the blocker                  |
| `causes` / `caused_by`         | Mark `[deleted]` in UI; retain for audit                   | Same                          | No effect                                            | No automatic effect                                        |
| `duplicates` / `duplicated_by` | Mark `[deleted]`                                           | Mark `[deleted]`              | No effect                                            | If auto-resolve enabled (open question 4), close duplicate |
| `relates_to`                   | Mark `[deleted]`                                           | Mark `[deleted]`              | No effect                                            | No automatic effect                                        |

Force-delete on parent orphans children and requires a reason written to the audit log.

---

## 5. Deliberate Exclusions

| Idea                                      | Reason                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Child state rolling up to parent          | Jira's dual Epic status fields are their most documented confusion point; Linear's auto-close has its own FAQ page |
| Sibling visibility                        | Direct accidental data exposure — "Update runbook" assignee should not see "Migrate customer data"                 |
| Per-field visibility per participant role | Multiplies complexity surface enormously; field-level sensitivity already exists in entity engine                  |
| Unlimited depth                           | Negligible operational value past level 5; recursive query risk and UX cost are not                                |
| Parallel approval logic                   | Deferred to Phase 3                                                                                                |

---

## 6. Open Questions for Human Sign-off

| #   | Question                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- |
| 1   | Should a child assignee have read-only or read + comment on ancestors?                             |
| 2   | Should `blocks` be enforced at the transition layer or advisory only?                              |
| 3   | Depth limit — 3 levels or 5?                                                                       |
| 4   | Should `duplicates` auto-resolve the duplicate when the original resolves?                         |
| 5   | How long should @mention-granted access persist after ticket resolution?                           |
| 6   | **Watcher role is recommended as first-class (§7.5) — sign-off required to confirm.**              |
| 7   | GDPR erasure policy when a ticket tree mixes PII-sensitive and non-sensitive tickets?              |
| 8   | Should ancestor access propagation be synchronous (same transaction) or eventual (via automation)? |

Record decisions here:

| #   | Decision | Decided by | Date |
| --- | -------- | ---------- | ---- |
| 1–8 |          |            |      |

---

## 7. Design Decisions

### 7.1 Parent-Child Relationship

One admin creates the parent; multiple agents get scoped, independent child tickets. Key trade-offs:

**Advantages:** Clear ownership per child, least-privilege scope isolation by default, natural progress rollup, clean audit trail, hierarchy mirrors real work breakdown.

**Limitations:** Upward visibility from child to parent is not automatic — without explicit propagation, agents work blind. Sibling blindness creates coordination friction. Re-parenting requires revoking and re-deriving ancestor access across two chains. One-parent constraint means a sub-task cannot belong to two parent initiatives simultaneously.

**Summary:** Right model for work decomposition where one ticket is a contained sub-unit of another. Not the right model for shared dependencies or parallel tracks — those have their own relation types.

---

### 7.2 Parallel Linking (`blocks` / `blocked_by`)

Two tickets are parallel when neither is a sub-unit of the other, but one cannot proceed until the other resolves. `blocks` does not grant access between the two tickets — they may belong to separate teams.

**Advisory vs. enforced:** Starting advisory (visible warning) and making enforcement opt-in is the lower-risk path. Enforcement mechanism: a per-workflow flag (`enforce_blocking: boolean`) matches the existing `allowed_roles` and `sla_hours` pattern on transitions — admins toggle it in the workflow editor; all tickets on that workflow inherit it. Alternative options (per-relation flag, tenant-level config) are more granular or coarser respectively, but less consistent with current patterns.

**Critical:** Cycle detection for `blocks` is a correctness requirement, not optional. A → B → A is an irresolvable deadlock.

---

### 7.3 Cause-Effect Linking (`causes` / `caused_by`)

Pure documentation primitive for post-mortems and audit. No workflow enforcement, no access propagation. Cycles are logically absurd but carry no system consequence — soft warning only. Value is in read/report contexts, not daily agent workflow.

---

### 7.4 @mention Access

**The Freshdesk model is what OpenWind will implement:** `POST /comments` returns a `mentions` array for mentioned users who lack current access; the frontend surfaces the "grant access?" dialog; the participant record is created only if the mentioner confirms. Mentioners who dismiss send the comment without granting access; the mentioned user receives a notification with no ticket link.

**Cascade notification problem:** In a deep ticket tree, a single parent state change can generate dozens of notifications to all ancestor-chain participants. The correct model is notification relevance filtering — notify participants about ancestors only on escalation events, not routine state changes.

**Escalation events** that warrant ancestor-chain notification:

| Event                                | Who gets notified              |
| ------------------------------------ | ------------------------------ |
| SLA breach on any ticket in the tree | Parent assignee and admin      |
| Ticket re-assigned                   | New assignee + parent assignee |
| Ticket reaches terminal state        | Parent assignee                |
| Blocking relation added              | The blocked ticket's assignee  |
| @mention of a participant            | The mentioned user only        |

Events that **do not** warrant ancestor notification: routine state transitions, comment additions, field updates, watcher-list changes on siblings.

---

### 7.5 Access Control Model

**Principle:** A user's access boundary is defined by what they are directly responsible for.

| What the user can see                             | Basis                                        |
| ------------------------------------------------- | -------------------------------------------- |
| Tickets directly assigned to them                 | Direct responsibility                        |
| Children of their assigned tickets                | Coordinator access                           |
| Ancestors of their assigned tickets               | Context (read-only)                          |
| Sibling tickets (same parent, different assignee) | **Not by default** — explicit grant required |
| Other branches of the ancestor chain              | **Never**                                    |

**Coordinator visibility:** The parent assignee sees all children — this is intentional coordinator access derived from holding the parent, not a peer relationship. Child-level agents never see each other's tickets through this mechanism.

**The watcher role** is a distinct third participant type, separate from assignee and mentioned:

| Property                | Assignee                                 | Mentioned                       | Watcher                                 |
| ----------------------- | ---------------------------------------- | ------------------------------- | --------------------------------------- |
| How created             | Assignment action                        | @mention grant (with dialog)    | Self-service "follow" or admin grant    |
| `granted_by`            | System (assignment event)                | User who wrote the mention      | Self or admin user ID                   |
| Access scope            | Full — ticket + children + ancestor read | Read-only on mentioned ticket   | Read-only on followed ticket            |
| Revoked when            | Re-assigned or re-parented               | Manual revocation or expiry     | Manual unfollow or ticket archived      |
| Survives re-assignment? | No                                       | Yes                             | Yes                                     |
| Notification events     | All                                      | Escalation events only          | Transition and resolution; not comments |
| Audit interpretation    | This person is responsible               | Pulled in for a specific reason | Elected to observe                      |

---

### 7.6 System Comparison Summary

| System           | Parent-child visibility                                         | @mention access                          | Blocking enforcement                 |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| **Jira**         | Child → parent requires manual grant (JRASERVER-5869 Won't Fix) | Notification only; no access grant       | Advisory link only                   |
| **Linear**       | Team-level only; no per-issue security                          | Blocks mention at input if no access     | Advisory only                        |
| **ServiceNow**   | Custom ACL scripting required                                   | Manual watch_list; no @mention primitive | Flow Designer only (automated flows) |
| **GitHub**       | 8 levels; repo-level access only                                | Ghost notification bug                   | Advisory (GA Aug 2025)               |
| **Freshdesk**    | Group-based; cross-group requires manual grant                  | Explicit opt-in dialog                   | Not supported                        |
| **Azure DevOps** | Area path ACLs; high config complexity                          | Notification only                        | Advisory only                        |
| **Zendesk**      | Flat links; group-based; silent failure on @mention             | Group membership required; no dialog     | Not supported                        |

---

### 7.7 Cycle Detection

DFS must run before accepting a new `parent_of` or `blocks` relation:

- **`parent_of`:** Walk the would-be parent's ancestor chain; reject if the would-be child appears in it.
- **`blocks`:** Walk the forward dependency chain of the would-be blocked ticket; reject if the would-be blocker appears in it.

**Concurrent creation race:** Acquire a `SELECT FOR UPDATE` row-level lock on the **would-be child** (for `parent_of`) or the **would-be blocked ticket** (for `blocks`) before the DFS begins. This ensures concurrent operations on the same node wait, while operations on unrelated branches proceed without contention — matching the pessimistic locking pattern the workflow engine uses for transitions.

**At scale:** DFS is O(n) in connected tickets. For deep transitive closure scenarios (>10,000 tickets with active `parent_of` chains), replace live DFS with a materialized view maintained by a background job.

---

### 7.8 Data Loss and Leak Risks

**Data loss:**

- Deleting a parent orphans children with no readable context ancestor
- Re-parenting strips access to comments the agent contributed to on old ancestors
- Automation double-trigger (#120) can create inconsistent participant records during propagation

**Data leak:**

- Cross-tenant UUID guessing: only explicit `WHERE tenant_id` filter is active defence until #121 is fixed. Return 404 not 403 to prevent existence leakage.
- Ancestor access outliving the relationship — requires linking participant records to the relation that created them
- @mention access persists indefinitely with no automatic expiry — admin must manually review
- Stale ancestor access after re-assignment (old assignee retains records)
- Sensitive fields visible via ancestor read access — enforce field-level `sensitivity = 'pii'` per participant role
- Notification emails containing ticket content — notifications must be link-only (see §8.1)

**Common thread:** Every leak risk is caused by access records that outlive the relationship that justified them.

---

### 7.9 Workflow Transitions vs. Stateless Tickets

**The decision: workflow transitions are core for top-level tickets; child tickets are stateless binary units.**

Every ticket with `workflow_id` set follows the full transition engine (role guards, condition trees, SLA, audit rows). Child tickets without `workflow_id` are open-or-done units — a named, assigned, commentable unit of work, not a mini-workflow.

**Who can mark a stateless child done:** Field update (`status = done`), governed by entity engine field-level write permissions. The ticket's assignee and any `agent` or `admin` role can update it. End-users with @mention access can read but not update. No new logic required — existing entity engine write rules apply.

Jira, Linear, and ServiceNow all documented confusion when child tickets have their own independent state machines (dual Epic status fields, unexpected auto-close behavior, parent-authoritative states disorienting agents). The binary child avoids all three failure modes.

---

## 8. Paradoxes

### 8.1 Notification vs. Privacy

Any notification about a restricted ticket leaks at minimum that the ticket exists and when it was updated. There is no approach that preserves both full notification delivery and full information privacy.

**OpenWind will use notification-only-by-link.** All Novu templates for ticket events must contain only: the ticket ID, the event type in plain language, and an authenticated deep link. Ticket titles, field values, comment content, and assignee names must not appear in notification bodies. This decision has GDPR implications — content in notification email leaves the access-controlled system and cannot be selectively erased on a right-of-erasure request.

### 8.2 Transparency vs. Security

Every security boundary is also a communication barrier. Per-ticket access control (the correct security answer) makes cross-team coordination harder, not easier, compared to coarser team-level models. The OpenWind model mitigates this by giving child assignees ancestor read access — the minimum transparency needed for coordination without exposing unrelated work.

### 8.3 Automation vs. Predictability

Automating access propagation makes access more correct over time but introduces a consistency window between when an assignment changes and when participant records reflect it. The alternative (synchronous writes in the same transaction as the triggering event) couples systems that should not be coupled.

Mitigation: idempotent upserts. Any number of automation retries produces exactly one active participant record. The consistency window remains, but its worst outcome is a brief access delay, not corrupt data.

### 8.4 Hierarchy vs. Reality

Tree structures require exactly one parent per node. Real work does not always fit this. A shared sub-task may legitimately belong to two parent initiatives. The one-parent constraint that makes access propagation clean is the same constraint that most frequently conflicts with how work is actually organized. `relates_to` exists as the escape valve — acknowledge the relationship without forcing it into a semantic category that carries access side effects.

### 8.5 Enforcement vs. Escape Hatch

Any enforced blocking must have an override path (situations change, blockers become irrelevant). The paradox: override capability, once available, tends to be used for convenience rather than genuine exceptions, degrading the enforcement into decoration. Mitigation: make every override a distinct audited event with a required reason field, raising the social cost of casual use.

### 8.6 Historical Access

When a user's access is revoked, their past comments remain visible to current participants. Should revoked users read their own past comments? Should current participants see comments from users who no longer have access? No system has a satisfactory answer — most treat comments as immutable public record once written. A filtered-by-author-role model has no precedent and adds prohibitive query complexity.

---

## 9. Anti-patterns

### 9.1 The God Ticket

A single parent accumulates dozens of children over months. Any state change generates notifications to every participant who ever touched any child. **Design-level mitigation:** the depth limit prevents subtrees on children of god tickets, limiting blast radius. UI mitigation: surface a warning when a ticket exceeds 50 `parent_of` relations.

### 9.2 Zombie Access

A user retains access long after the reason ended. Assignment-derived access is revoked when the triggering state reverses. Manually granted access (@mention, explicit add) has no automatic revocation trigger. **Mitigation:** participant records must carry an explicit expiry anchor tied to what created them. Records with null `granted_by_event` (manually created) surface in admin review panel as "no automatic expiry — review required."

### 9.3 The Broken Reference Problem

A ticket is soft-deleted; all relations pointing to it remain valid rows in `entity_relations`. The `deleted_at` column (§2.1) marks these relations as broken without removing them — queries filter `WHERE deleted_at IS NULL` for the active list. For `parent_of` chains: orphaned children display "[parent deleted]" and lose ancestor access. For `blocks`: §10.3 resolves this specifically — `blocks` relations are removed automatically when either endpoint is soft-deleted, so a deleted blocker cannot leave a ticket permanently stuck.

### 9.4 Notification Storms

A top-level resolution triggers: parent automation fires → all children transition → each child sends participant notifications → child automation rules fire. A single event can cascade to hundreds of deliveries in seconds. No system has a native solution. The correct architectural answer is a per-user notification rate limiter with digest rollup — but this requires stateful delivery history per user in the notification layer.

### 9.5 Re-parenting Access Continuity

Moving a child from parent A to parent B requires: walk chain A → identify propagation-created records → revoke them; walk chain B → write new records. If either walk fails partially, the agent has incorrect access. Their historical comments on chain A tickets remain visible to chain A participants but now refer to context the agent can no longer access. No system handles this gracefully — the practical workaround in large ServiceNow deployments is to create a new child under the correct parent and close the old one rather than re-parent.

---

## 10. Schema, API & Implementation Notes

### 10.1 Participant Table Schema

```sql
ticket_participants
  id                    UUID PK
  tenant_id             UUID NOT NULL
  instance_id           UUID NOT NULL FK → entity_instances
  user_id               TEXT NOT NULL             -- Zitadel user ID
  role                  TEXT NOT NULL             -- assignee | mentioned | watcher
  granted_by            TEXT                      -- grantor user ID; NULL if system-generated
  granted_by_event      TEXT                      -- event type (entity.assigned, comment.mention, etc.)
  granted_by_comment_id UUID                      -- FK → comments if grant came from @mention
  revoked_at            TIMESTAMPTZ               -- NULL = active
  revoked_reason        TEXT                      -- unassigned | reparented | expired | manual
  expires_at            TIMESTAMPTZ               -- NULL = no expiry (pending open question 5)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Constraints:**

- `UNIQUE (tenant_id, instance_id, user_id, role) WHERE revoked_at IS NULL` — partial index. Allows re-creation of the same `(user_id, role)` pair after revocation. Application code uses `INSERT … ON CONFLICT DO NOTHING` for idempotent upserts.
- `CHECK (role IN ('assignee', 'mentioned', 'watcher'))`
- One-assignee rule is application-layer: before inserting an `assignee` record, verify no active `assignee` record exists for a different user and revoke it if one does.
- RLS policy: `WHERE tenant_id = current_setting('app.tenant_id')::uuid` — identical shape to `entity_instances`.

**Indexes:**

- `(tenant_id, instance_id)` — participant list for a ticket
- `(tenant_id, user_id) WHERE revoked_at IS NULL` — "which tickets can this user see?"
- `(instance_id, granted_by_event)` — revocation sweep on assignment or re-parent

**Issue #120 safety:** Application code must use upsert (`ON CONFLICT DO NOTHING`), not plain insert. A double-triggered automation event produces a no-op rather than duplicate participant records.

---

### 10.2 API Surface

| Method   | Path                                       | Notes                                                                                                                                                                                                                |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/entities/:id`                            | Include `participants` array in response for admin/agent. End-users see only their own record.                                                                                                                       |
| `GET`    | `/entities/:id/participants`               | Full participant list; filter `?role=&active=`. Admin + agent only.                                                                                                                                                  |
| `POST`   | `/entities/:id/participants`               | Body: `{ user_id, role: "watcher" \| "mentioned" }`. `assignee` role excluded — must go through entity engine assignment action. Admin only.                                                                         |
| `DELETE` | `/entities/:id/participants/:userId/:role` | Takes `:role` to disambiguate (user may hold `mentioned` + `watcher` simultaneously). Sets `revoked_at`, `revoked_reason = manual`. Cannot revoke `assignee` — use re-assignment to trigger propagation. Admin only. |
| `POST`   | `/entities/:id/follow`                     | Self-service watcher. Available to any user who can already read the ticket. Writes `role = watcher`, `granted_by = self`.                                                                                           |
| `DELETE` | `/entities/:id/follow`                     | Self-service unfollow.                                                                                                                                                                                               |
| `POST`   | `/comments`                                | Modified: returns `mentions: [{ user_id, display_name, has_access }]` for mentioned users lacking access. Participant record written separately after confirmation.                                                  |
| `POST`   | `/entities/:id/participants/mention`       | Called after admin confirms access grant dialog. Body: `{ user_id, comment_id }`. Writes `role = mentioned`, `granted_by = caller`, `granted_by_comment_id`.                                                         |

---

### 10.3 Deletion Policy

| Relation type                        | Soft-delete behaviour                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parent_of` / `child_of`             | Block deletion if active children exist. Force-delete orphans children; ancestor participant records revoked in same transaction; requires reason in audit log. |
| `blocks` / `blocked_by`              | Automatically removed when either endpoint is soft-deleted. Prevents permanently blocked tickets.                                                               |
| `causes`, `duplicates`, `relates_to` | Set `entity_relations.deleted_at = now()`. Queries filter `WHERE deleted_at IS NULL` for active list; deleted relations shown as `[deleted]` in audit view.     |

---

### 10.4 Existing Ticket Migration

**Step 1 — Schema:** Add `ticket_participants` table with RLS. No application code changes yet; existing access checks still read `assigned_to`.

**Step 2 — Backfill:** One-time job reads every `entity_instances` row with non-null `assigned_to` and writes `role = assignee`, `granted_by = NULL`, `granted_by_event = system.backfill`. Safe to re-run (upsert pattern).

**Step 3 — Cutover:** Switch entity engine access checks from `assigned_to` to `ticket_participants WHERE role = 'assignee' AND revoked_at IS NULL`. During the one-release-cycle fallback window, `assigned_to` is kept in sync by the assignment action: every code path that writes an assignment also upserts the participant record and revokes the previous one. This is application-layer sync in the same transaction — not a database trigger. The subsequent migration drops `assigned_to` and removes all sync code.

---

### 10.5 Platform Prerequisites

**Must be fixed before participant model ships:**

1. **#121 (RLS role not set):** Participant table RLS is unenforced for the same reason as `entity_instances`. All joins must carry explicit `WHERE tenant_id = ?` on the participant table — cannot inherit from the join.
2. **#120 (automation double-trigger):** Affects ancestor propagation. The unique constraint protects against duplicate rows, but concurrent interleaved writes may produce records that survive when they should have been revoked. Fix the issue, not the symptom.

**Correct sequencing:** fix #121 → fix #120 → update isolation tests (#122) to cover participants → implement participant model.

---

### 10.6 Test Coverage

**Unit — cycle detection:**

- DFS correctly identifies and rejects a cycle in `parent_of` chain
- DFS correctly identifies and rejects a cycle in `blocks` chain
- DFS passes a valid tree without false positives
- Row-level lock prevents concurrent creation of a race-condition cycle

**Integration — participant propagation:**

- Assign child → participant record exists on each ancestor with `role = assignee`
- Re-assign child → old records revoked, new ones created
- Delete `child_of` relation → ancestor participant records revoked
- Re-parent child → old ancestor access revoked, new ancestor access derived in same pass

**Integration — access checks:**

- Child assignee: GET parent returns 200; POST transition returns 403; GET sibling returns 404
- Non-participant: GET any ticket in tree returns 404

**Isolation — RLS:**

- Participant record in tenant A is not readable by a query scoped to tenant B
- Ancestor-chain walk scoped to tenant A does not traverse tenant B relations

**Idempotency:**

- Fire `entity.assigned` twice → exactly one active participant record per ancestor
- Backfill migration run twice → no duplicate participant records

**Transition guard (when `blocks` enforcement is added):**

- Blocked ticket cannot transition while blocker is non-terminal
- Blocked ticket can transition after blocker reaches terminal state
- Force-transition override writes audit log entry with reason

---

### 10.7 Performance Thresholds

| Condition                                                          | Response                                       |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Ticket has > 50 `parent_of` relations                              | Surface god-ticket warning in UI; do not block |
| Ancestor-chain walk > 5ms at p95                                   | Investigate query plan; confirm indexes in use |
| Tenant exceeds 10,000 tickets with active `parent_of` / `child_of` | Evaluate transitive closure materialized view  |
| Worker ancestor-chain walk exceeds 50ms                            | Materialized view required; live DFS too slow  |

Participant access check ("can user X read ticket Y?") is a single indexed lookup by `(tenant_id, instance_id, user_id)` — O(1) regardless of tree size.

---

### 10.8 MVP Scope

**MVP (steps 1–3 of the five-step path):**

- `ticket_participants` table, RLS policy, indexes, backfill migration
- Access checks switched from `assigned_to` to participant table
- Typed relation semantics — one-parent constraint, depth limit, cycle detection for `parent_of` and `blocks`
- Ancestor access propagation via automation on `entity.assigned` and `entity.unassigned`

Closes the most painful daily problem (agents working blind on sub-tasks) and delivers typed relation taxonomy with all constraints enforced.

**After MVP:**

- @mention access grant dialog and `POST /entities/:id/participants/mention`
- `blocks` enforcement as a per-workflow transition condition
- Watcher self-service (`POST /entities/:id/follow`)

---

_End of document._
