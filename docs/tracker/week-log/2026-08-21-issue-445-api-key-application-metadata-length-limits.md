## 2026-08-21 — Issue #445: length limits on api_keys application metadata columns

**Session type:** Bug fix / defense-in-depth hardening
**Branch:** `chore/PLAT-445-api-key-application-metadata-length-limits`

### Completed this session

#### Issue #445 (api_keys application metadata columns were unbounded at the DB layer)

- Migration `0070_api_keys_application_metadata_length_limits.sql` (renumbered from 0069 to
  0070 during a later rebase — main's tip claimed 0069 first via PR #446) adds `CHECK` constraints
  bounding `application_name` (≤200), `application_description` (≤2000), and
  `application_contact_email` (≤320, RFC 5321's max address length) on `api_keys` — these
  columns were added unbounded `text` by migration 0068 (PR #439).
- `create.ts`'s `CreateApiKeySchema` gets a matching `.max(320)` on `applicationContactEmail` —
  the only one of the three fields with no Zod bound at all before this change
  (`applicationName`/`applicationDescription` already had `.max(200)`/`.max(2000)`).
- `create.ts`'s insert error handling now also catches a `23514` (check-violation) on an
  `api_keys_application_*` constraint and maps it to a clean `422 VALIDATION_ERROR`, matching
  the existing `23505`/`ClientIdInUseError` pattern two branches above — defense-in-depth for
  the Zod and DB bounds ever drifting apart, not an expected path today since both sets of
  limits are identical by construction.
- New real-Postgres test `apps/api/tests/integration/api-key-application-metadata-length.test.ts`
  (table-driven via `it.each`, not `tests/isolation/` — this proves a plain `CHECK` constraint,
  not cross-tenant/RLS behavior) plus a unit test in `create.test.ts` for the API-layer email
  rejection.
- `/review` (forked execution, ran three times as findings were fixed) caught a real gap: the
  migration's `CHECK` constraints validate all existing rows (no `NOT VALID` — this migrator's
  single-transaction convention, per migration 0037's own reasoning) and would hard-fail the
  whole migration if any pre-existing row already violates a bound — a genuine, if narrow,
  possibility since `application_contact_email` was unbounded at the API layer from migration
  0068 until this same change. Resolved by documenting the fail-loud-is-intentional reasoning
  in the migration (silent truncation would corrupt a contact email into an undeliverable
  string, which is worse) and confirming zero existing rows have any application metadata
  column populated in this repo's own dev/test databases as of this migration (`platform_test`
  checked directly; `platform` local dev doesn't yet have migration 0068's columns).
- Also caught during review: a test miscategorized as an isolation test without actually
  testing cross-tenant behavior (moved + renamed), 6 near-duplicate `it()` blocks (converted to
  `it.each`), and a test name referencing the issue/migration number instead of behavior
  (renamed) — all fixed in the same pass.
- Filed two follow-ups surfaced but kept out of this PR's approved scope: #450 (apps/api
  host-mode `pnpm test` fails 14 unrelated tests — Redis has no host port mapping in
  `docker-compose.yml` by design; confirmed pre-existing on clean `main`) and #451
  (`zitadel_client_id` has the same DB-unbounded-but-Zod-bounded gap as the three columns fixed
  here, deliberately not folded into this PR since issue #445 named only the application
  metadata columns).

### Verification

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- `pnpm test`: new/existing `api_keys` tests all pass (45/45 across the 4 relevant files); repo-wide run also shows the pre-existing, unrelated failures documented in #436 (worker outbox-poller flake) and #450 (apps/api Redis host-mode gap) — both confirmed to reproduce identically on a clean `main` checkout, unrelated to this diff.
- `pnpm test:isolation`: same pre-existing/unrelated failures as above; this diff's own isolation-adjacent coverage (now in `tests/integration/`) passes.
