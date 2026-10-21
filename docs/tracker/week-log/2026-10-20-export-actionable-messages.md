# 2026-10-20 — user data export: a message the admin can act on instead of a 404

- `POST /users/:userId/export` for a user with no row in this tenant now returns `422 USER_NOT_IN_WORKSPACE`
  with a message saying what to check (the Zitadel user id, and that the user has signed in at least once).
  A user from another tenant gets the same answer as one who does not exist, so nothing about other tenants is
  revealed.
- Downloading an export whose subject has since been erased or removed returns `410
EXPORT_NO_LONGER_AVAILABLE` with a clear message. A job id that does not exist, belongs to another tenant,
  or is not a user-data export stays `404`.
- Known gap, now stated in the spec: a person who exists only as a reference in other rows (no
  `tenant_users` row) still cannot be exported.
