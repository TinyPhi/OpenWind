## 2026-07-10 — Security audit finding #10: follow-up sweep found 6 more RLS-breakage bugs

### Done

Systematic sweep of every route file using plain `db` against the full list of
RLS-enabled tables (`entity_instances`, `entity_relations`, `entity_fields`,
`workflow_events`, `automation_rules`, `automation_executions`,
`connector_credentials`, `api_keys`, `tenant_users`, `files`,
`admin_audit_log`, `view_configs`, `saved_views`, `access_requests`).
Empirically verified each suspect against real Postgres (same method as #6:
`SET ROLE app_user` with no tenant GUC, check whether a real row is visible).
Found and fixed 6 more currently-broken routes, all the same root cause as #6:

- `apps/api/src/routes/admin/audit.ts`: `GET /admin/audit` always returned `[]`
  — wrapped `queryAuditLog` in `withTenantContext`.
- `apps/api/src/routes/api-keys/create.ts`: `POST /api-keys` failed outright
  with an RLS violation error — wrapped the insert.
- `apps/api/src/routes/api-keys/delete.ts`: `DELETE /api-keys/:id` always
  returned 404 (delete silently affected 0 rows) — wrapped the delete.
- `apps/api/src/routes/api-keys/list.ts`: `GET /api-keys` always returned `[]`
  — wrapped the select.
- `apps/api/src/routes/view-configs/index.ts`: both `GET` and `PATCH
  /admin/view-configs/:entityType` broken — wrapped both in
  `withTenantContext` (the PATCH handler's read-then-insert/upsert now runs
  inside one transaction instead of two separate un-scoped calls).
- `apps/api/src/routes/entities/set-child-status.ts`: the `getParentId` call
  was unwrapped (a mixed-usage file — its other three queries already used
  `withTenantContext` correctly), so setting a child ticket's status always
  failed with a bogus 422 `NOT_A_CHILD_TICKET`, since `entity_relations` was
  invisible without the tenant GUC.

Checked and confirmed **not** bugs: `files/{complete,delete,initiate}.ts` and
`entities/delete-attachment.ts` (the `@platform/files` functions they call
manage their own tenant context internally via an inner `db.transaction` +
`set_config`, so passing the plain `db` in is correct there — different,
equally-valid architecture, not the same gap); `modules/index.ts`,
`platform/roles.ts`, `platform/users.ts`, `preferences/notifications.ts`,
`admin/tenants.ts` (either touch only non-RLS tables like `tenants`/`modules`,
call out to Zitadel rather than Postgres, or already wrap every RLS-table
query correctly).

`apps/api/tests/isolation/rls-followup-fixes.isolation.test.ts` (new): 7 tests
against real Postgres covering all five of the newly-fixed routes (audit,
api-keys create/list/delete, view-configs GET/PATCH), each proving the
previously-broken behavior now works.

### Why

Requested follow-up to #6/#7: since #6 revealed the "plain `db` instead of
`withTenantContext`" pattern can silently break an entire feature against an
RLS-enabled table, and it had gone unnoticed for a while, a systematic sweep
was worth doing before treating the original audit's #6/#7 fix as complete.

**One notable side-effect discovered along the way:** the `view-configs.ts`
fix likely explains 4 of the "pre-existing baseline" `apps/api` test failures
I had been treating as unrelated flakiness across this whole session (the
`tests/integration/view-configs.test.ts` suite). That suite couldn't be used
to confirm the fix here, though — it needs a live Redis connection reachable
from the host, which this dev environment doesn't have published
(`docker port ow-cache` returns nothing); this is a pre-existing environment
gap, unrelated to the RLS bug, and the reason the isolation-test approach
(bypassing the full app's Redis-dependent middleware) was used instead.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run, clean)
- pnpm test: PASS — `@platform/api` unit tests +7 (the new isolation file).
  Root failures unchanged at the established 12-test baseline, including the
  4 `view-configs.test.ts` failures (confirmed these are the pre-existing
  Redis-connectivity gap, not the RLS bug — this fix doesn't touch Redis).
- pnpm test:isolation: PASS — 134/134 (15 files, up from 127/14).
- Manual verification against real Postgres before each fix (confirmed each
  bug): `admin_audit_log` SELECT returned 0 rows for a real row; `api_keys`
  INSERT failed with an RLS violation, SELECT/DELETE silently no-op'd;
  `view_configs` SELECT returned 0 rows for a real row. Rebuilt and restarted
  `ow-backend` after the fix — clean boot, health check passes.

### Next

Remaining items from the 2026-07-09 security audit's to-do list — both are
low-stakes, no known active bugs:
1. **#8** Introspection cache key: switch from 32-bit hash to SHA-256.
2. **#9** Confirm with product whether `users.ts` returning all tenant members'
   PII to `user`-role callers is intended (currently documented as deliberate).

This closes out the entire original audit list (#1-#10). Given how many
active bugs #6/#10 turned up, worth considering: is there a way to make this
class of bug fail loudly at dev/CI time (e.g. a lint rule flagging
`db.select/insert/update/delete` calls on a known-RLS table outside
`withTenantContext`) rather than relying on manual sweeps? Not implemented —
flagging as a process idea, not a coded fix.

### Open questions

- None blocking. The process-improvement idea above (a lint rule or codemod
  check for this bug class) is worth raising with the team, not something I
  implemented.
