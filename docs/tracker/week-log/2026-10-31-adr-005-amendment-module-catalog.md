# 2026-10-31 — ADR-005 Amendment 1: module catalog written by the migration role (#1079)

## Done

- Drafted Amendment 1 to ADR-005 (status Proposed, owner to accept): the module catalog is
  written by `migration_user` in a post-migrate sync step, not by `app_user` at API runtime.
- Added two inline "superseded in part" pointers and an `Amended by` header line in ADR-005.
- Verified inputs: `app_user` has SELECT only on `modules` (live check, 2026-10-30); no migration,
  seed or bootstrap writes module rows; `connector_definitions` and `plugin_definitions` are empty
  by design, so they are out of scope.

## Next

- Owner reviews and accepts or edits the amendment; then #1079 is implemented with a fresh-database
  test that logs in as a real `app_user`.

## Open

- Production migrate entry point, assertion strictness, and the worker's `MIGRATION_DATABASE_URL`
  (listed in the amendment's open questions).
