# Event-log protection

**Status:** Implemented (hardening PR 5, migration 0147). **Related:** `docs/specs/retention-classes.md`,
migration 0144 (`tenant_purge_role`), ADR-001.

## Problem

`workflow_events` is the history of a case: what changed state, when, and who acted. The request role
(`app_user`) could UPDATE and DELETE any event of its tenant, so a bug in a request path could rewrite or
remove that history.

## Behaviour

- `app_user` keeps SELECT and INSERT on `workflow_events`, plus UPDATE on three columns: `metadata`
  (comment attachments, resolved mentions and erasure scrubbing edit it), and `actor_id` and
  `origin_performer_user_id` (per-user erasure redacts them). `from_state`, `to_state`, `created_at`,
  `triggered_by` and the remaining columns can no longer be changed by the request role.
- A trigger (`workflow_events_identity_guard`) lets `actor_id` and `origin_performer_user_id` change only to the
  redaction marker `[REDACTED]` (the value `user-erasure.ts` writes). History can be anonymized but never
  re-attributed to another person, whichever role runs the UPDATE.
- DELETE belongs to **`event_log_maintenance_role`** (NOLOGIN, NOBYPASSRLS, granted to `app_user` WITH
  INHERIT FALSE, like `tenant_purge_role`). Code enters it through `withEventLogMaintenanceContext(tenantId)`,
  which sets the role and `app.tenant_id`, so the table's tenant RLS policy still confines it to one tenant.
  Callers keep their explicit `tenant_id` filters. The role has no UPDATE.
- The role can also SELECT `entity_instances` and `workflow_states`, which the retention sweep's open-case
  guard reads.
- Callers: the retention sweep (`retention-sweep.ts`, workflow_events deletes only), tenant purge and sandbox
  reset (events are deleted first, before the transaction that removes their parents).

## Scope

The grants guard against defects in application and request-path code. They sit alongside the tenant
RLS policies and the same `INHERIT FALSE` role shape as `tenant_purge_role` (0144).

## Metadata (migration 0148)

`metadata` holds what an event recorded when it was written (its `type` and the other keys). A
BEFORE UPDATE trigger (`workflow_events_metadata_guard`) limits an UPDATE to the keys the application and
erasure legitimately edit: `fileIds`, `mentions`, `mentionIdentifiers`, `text`, `actorName`,
`actingPersonId` and `changed`. Every other key, including `type`, is fixed once written, and no other key can
be added. `actingPersonId` and `actorName` may change only to `[REDACTED]`; `changed.<field>.old/new` only to
`[REDACTED]`, with the same fields. The content of `text`, `mentions`, `mentionIdentifiers` and `fileIds`
remains editable, and those four keys can still be added, removed or set to any value, because comments,
attachments and erasure edit them. The trigger protects the recorded `type` and the actor, not the comment body.

## Tests

`tests/isolation/event-log-protection.isolation.test.ts` (real Postgres; the metadata cases fail if the trigger is dropped): metadata edit works; rewriting
`to_state`, `from_state`, `created_at`, `triggered_by`, or re-attributing the actor or origin performer, and deleting, are refused for `app_user`; redacting the actor and origin performer is allowed;
the maintenance role cannot UPDATE and deletes only the tenant in context, even with no `tenant_id` filter.
Re-granting UPDATE and DELETE to `app_user` makes the column and delete tests fail, and dropping the trigger makes the re-attribution tests fail.
