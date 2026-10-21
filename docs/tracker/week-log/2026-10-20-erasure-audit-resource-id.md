# 2026-10-20 — erasure audit entry used a non-uuid resource id (#1048)

- `DELETE /users/:userId` wrote the Zitadel user id into `admin_audit_log.resource_id`, a `uuid NOT NULL`
  column. A real Zitadel id is a numeric string, so the insert threw inside the erasure transaction and the
  whole erasure rolled back. The unit test mocked the audit write and used a non-realistic id, so it passed.
- New `auditResourceId()` in `@platform/audit`: an id that is already a uuid is returned unchanged; anything
  else maps to a deterministic UUIDv5 under a fixed namespace (checked against Python's `uuid5`, and pinned in
  a test, because changing it would orphan existing entries). The real id goes in `metadata.userId`.
- Proof: the route unit test failed before the change; a real-database isolation test shows the raw id is
  rejected by the column, the mapped id is written and found by `queryAuditLog({ resourceId })`, and another
  tenant's entry for the same user id is not returned.
- Entries already written by other code paths use uuid resource ids and are unaffected. Past erasures through
  this route cannot have written an entry (they rolled back), so there is nothing to migrate.
