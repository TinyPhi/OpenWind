## 2026-08-24 — Toward issue #436: migration 0073 silently skipped (journal timestamp bug)

**Session type:** Bug fix / infra
**Branch:** `fix/PLAT-0073-migration-journal-timestamp`

### Completed this session

#### Found while reproducing #436 (outbox-poller isolation-test flake)

- Set out to reproduce and root-cause #436's flaky `outbox-poller-automation-exclusion`/
  `-dedup-race` isolation-test timeouts. Discovered `pnpm test` was actually failing
  **deterministically**, for an unrelated reason, before ever reaching that flake: migration
  `0073_admin_audit_log_acting_person.sql` was silently skipped by drizzle-orm's postgres-js
  migrator.
- Root cause: `packages/db/migrations/meta/_journal.json`'s `when` for idx 73
  (`1785542424000`) was smaller than idx 72's already-applied `created_at`
  (`1787414412147`, a real `Date.now()`-based value). Drizzle's migrator only applies a
  migration when `lastDbMigration.created_at < migration.folderMillis`
  (`node_modules/drizzle-orm/pg-core/dialect.js:56-70`), and `lastDbMigration` is fetched once
  before the loop and never refreshed — so this only bites an **incrementally**-migrated
  database (a from-scratch bootstrap applies everything unconditionally, since
  `lastDbMigration` starts undefined for the whole run). Traced by diffing
  `__drizzle_migrations`' applied hashes against the journal's declared hashes.
- Fixed by bumping idx 73's `when` to `1787414413147` — a one-line change, no SQL touched.
- While diagnosing, found the identical class of bug on migration 0071
  (`api_keys_zitadel_client_id_length_limit`) — but it's not a pure timestamp fix there: 0071's
  SQL targets `zitadel_client_id`, which migration 0072 renames to `oidc_client_id`. On a fresh
  DB 0071 runs before 0072 and succeeds; on any already-migrated DB where 0072 already ran,
  0071 now fails outright (column doesn't exist under that name). Filed as
  [#474](../../../issues/474) rather than folded into this fix — needs a new forward migration,
  not a timestamp bump, and touches schema-contract territory a human should sign off on.
  Confirmed with the human: keep this branch scoped to 0073 only.
- No new test added — `apps/api/tests/isolation/third-party-ticket-create.isolation.test.ts`
  (pre-existing, PR #465/#466) already writes an audit entry with `actingPersonId` and reads it
  back through `adminAuditLog.actingPersonId`, so it already regression-guards this exact
  column; it was failing on any DB hitting this bug and passes once 0073 actually runs.

### Verification

- Verified against a genuinely fresh Postgres database (mirroring what CI does), to separate
  this fix's effect from #474's pre-existing, separately-filed fallout on any already-migrated
  local DB:
  - `pnpm db:migrate`: 0071/0072/0073 all apply cleanly on fresh bootstrap
  - `pnpm typecheck`: PASS
  - `pnpm lint`: PASS
  - `pnpm test`: PASS — 30/30 tasks, 1078/1078 tests in `@platform/api` alone
  - `pnpm test:isolation`: PASS — 17/17 tasks (worker 4/4 files, api 61/61)
- On the local, pre-existing, incrementally-migrated `platform_test` DB (still missing 0071 per
  #474), `pnpm test` shows one unrelated failure (`api-key-application-metadata-length.test.ts`)
  — confirmed to be #474's fallout, not this fix, by the fresh-DB comparison above.

### Next

- Resume #436 itself (the outbox-poller flake) now that `pnpm test`/`pnpm test:isolation` have
  a real green baseline to flake against, instead of masking it behind this unrelated failure.
