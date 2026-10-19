# 2026-10-19 — Sandbox seeding outbox suppression (#830)

**Session type:** Fix found in review of the stacked PRs #986–#991
**Branch:** `feat/admin-ui-tests` (the tip of the stack, landed as one PR)

- **Found.** The per-record and per-transition suppression added for #830 filtered on
  `created_at >= moduleStartedAt`, a timestamp read from the app clock inside the seeding transaction. An outbox
  row's `created_at` defaults to `now()`, which Postgres pins to the transaction's start, so every row the
  transaction wrote predated the cut-off and the update matched nothing. The final sweep still worked (its cut-off is
  taken before any transaction), so the race between a module's commit and that sweep stayed open. The unit test
  mocked `where`, so it could not see it.
- **Fixed.** `suppressOutboxEventsWrittenByThisTransaction` compares against the database's own
  `transaction_timestamp()`, which equals the `created_at` of every row both engines write in the transaction (they
  rely on the column default). It also removes any app/database clock skew from the comparison.
- **Verified.** A real-Postgres isolation test (`sandbox-outbox-suppression.isolation.test.ts`): the event the
  transaction wrote is delivered even after a delay, events written after an earlier call in the same transaction
  are covered, and an older undelivered event of the same tenant and another tenant's event are left alone. With
  the old app-clock cut-off swapped back in, two of the three fail. The unit test now asserts the new predicate for
  the per-record and per-transition calls and still pins the final sweep's `gte`.
- **Deferred.** The final sweep still compares an app-clock cut-off with database `created_at`, which is correct
  on one host but is the same cross-clock pattern; with the per-module suppression working it is only a backstop.
  Rows another transaction writes for the same tenant while a module is seeding would also be suppressed; a sandbox
  being seeded has no other writers.
