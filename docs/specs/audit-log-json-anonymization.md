# Audit log JSON anonymization — tenant purge (#860)

> A tenant purge replaces person identifiers held in `admin_audit_log`'s JSON columns, not only in
> `actor_id` and `acting_person_id`, so Phase G R9 is true as written.

status: implemented
created: 2026-10-13
updated: 2026-10-13

---

## §G Goal

After a tenant purge, no `admin_audit_log` row for that tenant carries a user id or member email
in `metadata`, `before_snapshot` or `after_snapshot`. Aggregate history (action, resource type,
timestamp) survives, as R9 requires. A new audit action can't add an identifier that the purge
misses.

## §F Findings

- **F1:** `anonymizeAuditLogForTenant` (`packages/audit/src/index.ts`) rewrites only `actor_id` and
  `acting_person_id`. Ids in the JSON columns survive until the 90-day rollup. Examples:
  `access.*` (`metadata.targetUserId`), `workflow.admins_updated` (`assignedTo` snapshots), on-call
  roster entries (`primaryUserId`, `backupUserId`, `escalationManagerUserId`) and entity snapshots.
- **F2:** the write surface is wide (83 `writeAuditEntry` call sites, 38+ actions, plus the entity
  audit hook that snapshots whole entities), so a path registry ("action → JSON path") would drift.
- **F3:** `tenant-purge.ts` deletes `tenant_users` in its main transaction and anonymizes the audit
  log after it commits. By then the member list is gone, so a job that failed and retried could not
  rebuild it.
- **F4:** the batch loop selects "rows whose actor columns are not yet anonymized". A row whose
  actor columns are already scrubbed would never be revisited for JSON.

## §D Decisions

- **D1 — scrub by value, not by path.** Walk every JSON value and replace any string equal to a
  known person identifier. No registry, so a new action can't be missed.
- **D2 — identifier set:** the tenant's `tenant_users.user_id` and `email`, plus the distinct user
  `actor_id` and `acting_person_id` values in the tenant's audit rows (covers people who acted but
  are no longer members). Ids shorter than 3 characters are ignored. Emails match case-insensitively.
  Display names are **not** matched: they aren't unique, so a value match would hit unrelated text.
- **D3 — object keys count.** A key equal to an identifier is renamed to the placeholder.
- **D4 — run before the delete transaction.** The purge anonymizes the audit log in its privileged
  pre-step, while `tenant_users` still exists, so a retry always has the full set (F3). The call is
  idempotent.
- **D5 — keyset batching** on `id`, so the loop terminates and revisits rows whatever their actor
  columns hold (F4).
- **D6 — out of scope:** per-user erasure of `admin_audit_log` (kept on purpose, Art. 17(3)(b));
  `resource_id` (a `uuid NOT NULL`, never a person id); free text in snapshots that merely
  contains an identifier inside a longer string; no backfill of already-purged tenants (no
  production data).
- **D7 — accepted limits:** matching is exact string equality (uppercase uuids, ids stored as JSON
  numbers and identifiers inside longer strings are not found); a member id or email equal to an
  ordinary 3+ character word would redact that word in the tenant's JSON; a document deeper than 64
  levels is replaced whole rather than walked (fail closed); and an audit row written after the walk
  passes it but before the actor pass keeps its JSON ids (a narrow window the old ordering shared).

## §R Requirements

- R1: after a purge, no JSON column of the tenant's audit rows contains a collected identifier as
  a string value, nested at any depth, in an array, or as an object key.
- R2: other tenants' rows are untouched, including rows holding the same ids.
- R3: aggregate fields (action, resource type, resource id, timestamps) are unchanged.
- R4: the function is idempotent and safe to re-run after a partial failure.
- R5: a row that a purge has scrubbed once is not rewritten again.
- R6: a CI test seeds identifiers at several depths, under keys and values and in arrays, for
  more than one action, so a regression in the walk fails.

## §V Invariants

- V1: only string values and keys equal to a collected identifier change. Structure, numbers and
  other strings are preserved.
- V2: every statement filters `tenant_id` explicitly.

## §T Tasks

| id  | task                                                                                   | req    | status |
| --- | -------------------------------------------------------------------------------------- | ------ | ------ |
| T1  | Isolation test: ids at depth, in arrays, as keys; emails; bystander tenant; idempotent | R1–R6  | done   |
| T2  | `scrubPersonIdentifiers` walk + identifier collection in `packages/audit`              | R1, V1 | done   |
| T3  | Keyset batch loop; run JSON pass before the actor pass                                 | R4, R5 | done   |
| T4  | Move the call into the purge pre-step; update comments and the purge test              | R4     | done   |
