## 2026-07-10 — Security audit finding #1: record-level read access not enforced

### Done

- `apps/api/src/lib/entity-access.ts` (new): shared `hasEntityReadAccess(instance, userId, roles)`
  helper — admin/agent always true; otherwise `createdBy`/`assignedTo` match, or
  `__accessUsers[userId].level` is `read_comment`/`read_write`. Mirrors the existing
  write-side check in `create-attachment.ts` (left untouched — different semantics,
  only `read_write` grants write).
- `apps/api/src/routes/entities/get.ts`: `GET /entities/:id` now runs
  `hasEntityReadAccess` after fetching the instance; denies with 404 (not 403, matching
  the existing cross-tenant convention). Previously any tenant member, any role, could
  fetch any record's full fields by ID regardless of `__accessUsers`.
- `apps/api/src/routes/entities/list-attachments.ts`: same check added to the existing
  tenant-scoped instance lookup (extended its column selection to include
  `createdBy`/`assignedTo`/`fields`).
- `apps/api/src/routes/files/download.ts`: now looks up the file's bound entity (if
  any) before calling `getDownloadUrl`, and runs the same check against that entity.
  Files not bound to an entity (`entityId === null`) skip the check, unchanged.
- Tests: `get.test.ts` +3 cases (denied/owner/granted-access), new
  `list-attachments.test.ts` (5 cases), `files.test.ts` +4 cases. All follow the
  Prove-It pattern — each denial case would fail on pre-fix code.
- Fixed 2 pre-existing broken tests in `get.test.ts` as a side effect: the
  `@platform/db` mock was missing `entityRelations`/`workflows` exports that
  `getAncestorDepth` needs (called unconditionally on every request) — these two
  tests were already in the established pre-existing-failure baseline from the
  2026-07-09 sessions; not something this session broke.
- Also fixed `apps/api/src/routes/files/files.test.ts`'s `@platform/db` mock, which
  needed `files`/`entityInstances`/`withTenantContext` added for the download.ts change
  (4 of its existing tests would otherwise 500).

### Why

Surfaced by a parallel security audit (6 focused sub-audits: auth/session, tenant
isolation, injection, file access, secrets/logging, API data exposure) run at the
user's request to find security issues and data leaks. The file-access audit found
`list-attachments.ts`/`download.ts` didn't enforce the same `__accessUsers` ACL that
`create-attachment.ts`/`delete-attachment.ts` already do (write path gated, read path
wasn't). Investigating that led to a broader finding: `get.ts` itself has zero
access-level check — the base record read was tenant-wide for any role. User confirmed
(via clarifying question) that broad-tenant-read was NOT intended; record-level access
should be enforced consistently, not just on comment/attach/child-status actions.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS
- pnpm test: PASS for auth/files/entity-engine/workflow-engine/automation-engine/etc.
  `@platform/api` failures dropped from the established 14-test baseline to 12 — the
  2 fixed were the get.test.ts mock-gap failures above, confirmed unrelated to this
  session's other pre-existing failures (modules/view-configs/upload-flow/
  quarantine-flow/zitadel-management/list-workflow-events/transitions-events — all
  still present, all pre-existing per prior sessions' git-stash comparison).
- pnpm test:isolation: PASS (119/119)
- No live e2e check this time — entity/ticket routes are JWT-only by design and this
  dev stack has no running Zitadel to mint real tokens (established in the prior
  load-testing session). Relying on unit + isolation coverage instead.

### Next

Remaining items from the 2026-07-09 security audit's to-do list, in order:
1. **#2** CSV/XLSX export formula injection (`export-utils.ts`, `export-worker.ts`)
   — Priority 1, not yet started.
2. **#3** `ZITADEL_AUDIENCE` should be required, not silently skipped when unset.
3. **#4** Zitadel error-body logging on failure paths (`zitadel-management.ts`).
4. **#5** Tenant-status cache cross-instance invalidation.
5. **#6/#7** Defense-in-depth: `automation-rules` routes via `withTenantContext`;
   `entity-types` mutation statements missing a belt-and-suspenders tenant filter.
6. **#8/#9/#10** Introspection cache hash, `users.ts` PII-exposure design confirmation,
   follow-up audit pass on ~90 unreviewed route files.

### Open questions

- None blocking. Confirm with product whether the `hasEntityReadAccess` semantics
  (read_comment OR read_write grants view) match intent — currently anyone with ANY
  granted access level can view the record, only read_write can attach/write.
