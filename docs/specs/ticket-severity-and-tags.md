# Ticket Severity + Custom Tagging

> mandatory severity (Low/Med/High/Crit) + freeform shared tags, on all workflow-instance
> tickets platform-wide, w/ audit logging + severity-change notifications.

status: draft
created: 2026-09-04
updated: 2026-09-04

---

## §G Goal

Every workflow-driven entity instance (ticket, any module, any workflow) carries a mandatory
severity level and zero-or-more freeform tags. Users filter records by both on the records
page. Severity changes notify everyone with ticket access; both severity + tag changes are
fully audit-logged.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | entity-engine (schema+validation), workflow-engine (instance scope), existing outbound notification service, existing audit log                                                                                                                                         |
| auth         | reuses existing ticket edit-access rule: creator, assignee, workflow admin, global admin                                                                                                                                                                                |
| scope        | workflow-bound entity instances only — NOT plain non-workflow data records (e.g. CRM contact card, invoice line)                                                                                                                                                        |
| out of scope | third-party/partner API support for setting severity or tags (creates always default Medium, no tag params); tag autocomplete/suggestion; cross-ticket tag dedup; per-user private tags; automations beyond the fixed notification (e.g. SLA retiming on severity bump) |

## §I Interfaces

**Severity** — fixed global enum, same for every tenant:

| rank | name     | color     |
| ---- | -------- | --------- |
| 1    | Low      | gray/blue |
| 2    | Medium   | yellow    |
| 3    | High     | orange    |
| 4    | Critical | red       |

- New column directly on `packages/db/src/schema/entity-engine.ts`'s `entity_instances` table
  — this is the single shared table backing every module's workflow-driven records (confirmed:
  no per-module instance table exists), so one schema change covers all modules. Column is
  nullable at the DB level — no backfill migration; existing rows simply get `NULL`. The Edit
  Ticket form treats it as a required field (red asterisk) that blocks client-side submit when
  empty, and the save endpoint re-validates it's set server-side (never trust client-only
  validation).
- New ticket creation: severity always required at submit time, pre-filled with Medium,
  user may change before submit. Every creation path (admin-ui and third-party API) writes a
  non-NULL severity — `NULL` is a state that can only exist on rows that predate this feature
  shipping; no code path created after this feature ships ever writes `NULL`.
- Existing tickets created before this feature: severity is unset (`NULL`) until the ticket
  is next opened in the Edit form and saved.

**Tags** — freeform per-ticket, many-to-many:

- New join table (tenant-scoped, RLS) linking `entity_instance_id` ↔ tag text, with
  `created_by` (person id) and `created_at` — this is what enables the creator-lock on removal.
- Tag text normalized on input: trim leading/trailing whitespace, lowercase.
- Max tag length: 50 characters (rejected client- and server-side beyond that).
- Reject empty-string submissions.
- Reject exact-duplicate tag text already present _on that same ticket_ (post-normalization)
  with a clear error — no dedup/normalization enforced _across_ tickets (e.g. "railway" and
  "railways" are treated as distinct tags tenant-wide; that's accepted user variance, not a bug).
- Uniqueness is enforced at the DB level as a composite constraint on
  `(tenant_id, entity_instance_id, normalized_tag_text)` — the same-ticket duplicate check is
  not just an application-level pre-check, so two concurrent submits of the same normalized
  tag on the same ticket cannot both succeed; the second submit fails the constraint and is
  surfaced to the user as the same "already exists on this ticket" error.
- No predefined/admin-managed tag list — any user with ticket edit-access can type a new tag.

**Activity log entries** (reuses existing ticket activity-history mechanism):

- `severity.changed` — old value, new value, actor id, timestamp
- `tag.added` — tag text, actor id, timestamp
- `tag.removed` — tag text, original creator id, removed-by actor id, timestamp (distinct
  from creator id when removed by admin override)

**Notifications** (reuses existing outbound notification service — in-app + email):

- Fired on every `severity.changed` event, to every user in the ticket's access list.
- **Not** fired for tag add/remove (explicitly excluded — high frequency, low signal).
- Fan-out uses the outbound service's existing batching/rate-limit behavior (ADR-013/014) —
  this feature does not introduce a new synchronous-fan-out or bulk-notification code path,
  regardless of how large a given ticket's access list is.

## §R Requirements

R1: Every workflow-instance ticket has exactly one severity value once set; new tickets require
one at creation.
✓ Creating a ticket with no severity selected is impossible via the UI (defaults to Medium,
pre-filled)
✓ A workflow-instance ticket's severity value is always one of Low/Medium/High/Critical — no
other value can be persisted
✓ A ticket created via third-party API is created with severity = Medium, unconditionally

R2: Existing tickets (pre-feature) are not retroactively broken, but become required to set
severity the next time they're edited.
✓ A ticket created before this feature has `severity = NULL` after migration
✓ Opening that ticket's Edit form shows severity as an empty required field; submitting the
form with severity still empty is blocked client-side and rejected server-side if attempted
directly
✓ All other ticket actions (comment, assignee change, workflow transition, etc.) on such a
ticket are unaffected — no severity gate on anything except the Edit-ticket-form save path

R3: Severity is editable at any time by anyone with ticket edit-access, and every change is
logged and notified.
✓ Creator, assignee, workflow admin, and global admin can change severity on the ticket detail
page; no one else can
✓ Every severity change writes an activity-log entry recording old value, new value, actor,
timestamp
✓ Every severity change triggers an in-app + email notification (via the existing outbound
service) to every user in that ticket's access list

R4: Tickets support multiple freeform tags, shared across all viewers of the ticket.
✓ A ticket can have 0, 1, or many tags simultaneously
✓ Tag text is trimmed and lowercased on submit
✓ Submitting an empty tag is rejected
✓ Submitting a tag whose normalized text exactly matches an existing tag already on that same
ticket is rejected with an "already exists on this ticket" error
✓ Two different tickets can independently carry the same tag text, and near-duplicate tag text
(e.g. singular/plural) on different tickets is accepted without any cross-ticket normalization

R5: Tag add/remove follows a creator-lock, overridable by admins, and is always logged (never
notified).
✓ Any user with ticket edit-access can add a new tag to the ticket
✓ Only the person who added a given tag can remove that specific tag instance
✓ Global admin and workflow admin can remove any tag regardless of who added it
✓ Every add/remove writes an activity-log entry (tag text, actor, timestamp; for admin-override
removals, also records the original creator's id)
✓ No notification of any kind is triggered by a tag add or remove

R6: Records page supports filtering by severity and by tag.
✓ A severity filter lets the user narrow the record list to one or more severity levels
✓ A tag filter is a debounced freeform text input; typing filters the list to tickets carrying
a tag that exactly matches (post-normalization) the typed text
✓ The filter input text is normalized (trim + lowercase) the same way tag creation is, before
matching — a user typing "Railways " still matches tickets tagged "railways"
✓ Both filters compose with the existing Source (Internal/External/Redirected) filter already
on the records page

R7: This feature applies platform-wide to every workflow-bound entity instance, not just the
helpdesk ticket module, and not to non-workflow data records.
✓ Any module's workflow-driven record (any workflow config, any module) has the severity
column and can carry tags — enforced structurally, since severity and the tags join table
live on/against the shared `entity_instances` table in `packages/db/src/schema/entity-engine.ts`
that every module's workflow instances already use (confirmed: no per-module instance table
exists), not a per-module carve-out
✓ A plain non-workflow entity instance (no state/transitions) does not gain a severity column
or a tag relationship via this feature

## §V Invariants

- Severity is always one of exactly 4 fixed enum values (Low/Medium/High/Critical) — never a
  free-typed string, never tenant-customizable.
- A tag row's `created_by` is immutable once written — it is the sole source of truth for the
  creator-lock; it is never reassigned on edit (tags have no edit, only add/remove).
- Severity-change notifications and tag-change audit entries both reuse the _existing_
  outbound-notification / activity-log mechanisms already wired for other ticket events — no
  parallel notification or logging pathway is introduced by this feature.
- No third-party/partner API surface accepts a severity or tag value in this version — any
  future exposure there is a separate, explicitly-scoped change (see ADR-010/012 precedent for
  how that surface gets extended).
- `severity = NULL` exists only on rows created before this feature shipped. No code path that
  creates a ticket after this feature ships — admin-ui or third-party API — ever persists a
  NULL severity; Medium-or-user-chosen is written at creation time, unconditionally.
- The tags join table is tenant-scoped with RLS enabled, following the same per-tenant
  isolation pattern as every other tenant-scoped table in this platform (ADR-007) — every
  query against it carries an explicit `tenant_id` filter in addition to RLS, per security.md
  rule 1.
- Tag uniqueness on `(tenant_id, entity_instance_id, normalized_tag_text)` is a DB-level
  constraint, not merely an application-level check — concurrent duplicate submissions cannot
  both succeed.

## §T Tasks

Full phase-gated breakdown: `docs/specs/ticket-severity-and-tags-tasks.md`

| id  | task                                                               | phase | status | depends  |
| --- | ------------------------------------------------------------------ | ----- | ------ | -------- |
| T1  | severity column + migration on entity_instances                    | 1     | todo   | —        |
| T2  | entity_instance_tags join table + RLS + composite unique index     | 1     | todo   | —        |
| T3  | migration files + journal + analytics annotations                  | 1     | todo   | T1,T2    |
| T4  | Zod/TS types for severity enum + tag shape                         | 1     | todo   | T1,T2    |
| T5  | isolation tests: RLS + composite-uniqueness                        | 1     | todo   | T1,T2    |
| T6  | ticket-create routes: severity required/default/third-party-Medium | 2     | todo   | T1,T4    |
| T7  | ticket-edit route: severity gate + audit log + notification        | 2     | todo   | T1,T4    |
| T8  | tag-add route: normalize/validate/dedup/audit log                  | 2     | todo   | T2,T4    |
| T9  | tag-remove route: creator-lock + admin override + audit log        | 2     | todo   | T2,T4    |
| T10 | records-list route: severity + tag filters                         | 2     | todo   | T1,T2    |
| T11 | integration/isolation tests for T6–T10                             | 2     | todo   | T6-T10   |
| T12 | ticket-create form UI                                              | 3     | todo   | T6       |
| T13 | ticket-detail severity control UI                                  | 3     | todo   | T7       |
| T14 | ticket-detail tag add/remove UI                                    | 3     | todo   | T8,T9    |
| T15 | ticket-detail activity/timeline rendering                          | 3     | todo   | T7,T8,T9 |
| T16 | records page severity + tag filter UI                              | 3     | todo   | T10      |
| T17 | component/e2e tests for T12–T16                                    | 3     | todo   | T12-T16  |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
