## 2026-07-09 — API key auth broken by RLS enforcement (#121 side effect)

### Done

- `packages/db/migrations/0031_api_key_lookup_function.sql` (new): adds
  `resolve_api_key_by_hash(text)`, a narrowly-scoped `SECURITY DEFINER` SQL
  function that bypasses RLS on `api_keys` for one exact-hash lookup, returning
  only `id, tenant_id, scopes` (never `key_hash`). `REVOKE ALL FROM PUBLIC`,
  `GRANT EXECUTE TO app_user` only. Passed a scoped `/security-review`
  (checked: column leakage, search-path hijacking, enumeration via app_user,
  injection, ownership/privilege escalation — no findings).
- `packages/auth/src/middleware.ts`: `resolveApiKey` now calls
  `resolve_api_key_by_hash` via `db.execute(sql\`...${keyHash}::text\`)`
  instead of a direct `select().from(apiKeys)` (which RLS silently returns
  zero rows for, since the tenant isn't known until after this lookup
  succeeds — a chicken-and-egg problem the #121 RLS-role fix exposed). The
  `last_used_at` write now runs inside `withTenantContext(row.tenant_id, ...)`
  once the tenant is known, so it's a normal RLS-compliant write instead of a
  silent `UPDATE 0`.
- `packages/auth/src/middleware.test.ts`: updated the three existing API-key
  tests to mock `db.execute` instead of `db.select`, and added `sql`/`update`
  to the module mocks.
- `apps/api/tests/isolation/api-key-auth.isolation.test.ts` (new): 7 tests
  against real Postgres — `resolve_api_key_by_hash` resolves each tenant's own
  key and never the other tenant's, returns nothing for an unknown hash, never
  exposes `key_hash`; a full `requireAuth()` request authenticates end-to-end
  with an API key, rejects unknown keys with 401, and records `last_used_at`
  on the right tenant's row.
- `packages/db/migrations/meta/_journal.json`: registered `0031`.

### Why

Found while setting up an authenticated request for a load-test script (the
original ask: verify the system handles 30-40 concurrent users). Every API
key request has returned 401 "Invalid API key" — for every tenant, always —
since the #121 fix started actually enforcing `SET LOCAL ROLE app_user`.
`api_keys`' `tenant_read` RLS policy requires `app.tenant_id` to already be
set, but the whole point of this lookup is to discover which tenant a key
belongs to. Confirmed directly against Postgres before writing any fix:
`SET ROLE app_user; SELECT * FROM api_keys WHERE key_hash = '<valid>';` →
0 rows. Same for the `last_used_at` UPDATE. This is a correctness regression,
not a hypothetical — any integration using API keys (not browser/JWT logins)
has been unable to authenticate since #121 shipped.

The migration required explicit user authorization before applying (the
auto-mode classifier correctly blocked `pnpm db:migrate` as an RLS-bypass
change) — approved after a scoped `/security-review` found no issues.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS
- pnpm test: PASS — `@platform/auth` 24/24 (incl. 3 updated API-key tests).
  Root suite: same 14 pre-existing failures as the established baseline
  (`git stash` comparison from the prior #124 session), unrelated to this
  change.
- pnpm test:isolation: PASS — 119/119 (13 files, up from 112/12 — added
  `api-key-auth.isolation.test.ts`).
- Manual end-to-end proof against the real running stack (`ow-backend`
  rebuilt + restarted): a throwaway `sk_...` key returned 200 with real data
  from `/modules` (was 401 before the fix), `last_used_at` was written, and
  an unknown key still correctly returns 401. Test data cleaned up after.

### Discovered but explicitly out of scope

- **Migration tracker drift**: this dev DB's `drizzle.__drizzle_migrations`
  table stops at id 24, but `meta/_journal.json` lists entries through 30 (now
  31). Migrations 25-30 were applied to this dev DB by some means outside the
  drizzle migrator (`pnpm db:migrate` itself fails with `relation ... already
  exists` when run fresh, because it tries to redo an already-applied
  migration whose hash doesn't match its tracked record). I applied 0031's SQL
  directly via `psql` instead of fighting this drift, and deliberately did
  NOT insert a matching tracker row (would misrepresent 25-30 as applied when
  they aren't tracked). This should be looked at before it causes a real
  `db:migrate` failure in another environment — possibly CI is unaffected if
  it always starts from a fresh `platform_test`, but worth confirming.

### Next

Per the load-readiness to-do list, in order:
1. Now that an authenticated request path works again, actually run the
   30-40 concurrent user load test (autocannon, confirmed available via
   `npx`) that started this investigation.
2. #128 (OpenBao/MinIO commented out of `docker-compose.yml`) — for real app
   functionality; separate from the already-fixed test-script dependency bug.
3. Investigate the migration tracker drift noted above.

### Open questions

- None blocking. Flagged the migration tracker drift above rather than fixing
  it now — it's a separate, pre-existing problem and risky to touch without
  understanding how 25-30 got applied out-of-band.
