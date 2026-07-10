## 2026-07-10 — Security audit finding #5: tenant-status cache cross-instance invalidation

### Done

- `packages/auth/src/tenant-status-cache.ts`: `invalidateTenantStatusCache` now
  publishes the tenantId on a new Redis pub/sub channel (`tenant-status:invalidate`)
  after clearing the local cache, best-effort (guarded by `redis.status ===
  "ready"` — a down Redis just falls back to the existing 30s TTL, no worse than
  before). New `startTenantStatusInvalidationSubscriber()`/
  `stopTenantStatusInvalidationSubscriber()` — a dedicated `getRedis().duplicate()`
  connection (required: ioredis clients in subscribe mode can't run other
  commands) that clears the local cache on message.
- `packages/auth/src/index.ts`: exports the two new subscriber functions.
- `packages/auth/package.json`: added `@platform/redis` as a dependency
  (precedent: `entity-engine` already depends on it the same way for its
  schema cache).
- `apps/api/src/index.ts`: starts the subscriber at server boot, stops it
  during graceful shutdown alongside the existing `closeRedis()` call.
- `packages/auth/src/tenant-status-cache.test.ts` (new): 9 tests — baseline
  get/set/TTL behavior (previously untested), publish-on-invalidate,
  skip-publish-when-redis-down (no throw), subscriber idempotency, clean
  shutdown, and a cross-instance simulation proving a second "process"
  (a separately `vi.resetModules()`-loaded instance of the module, sharing a
  fake in-memory pub/sub) has its local cache cleared by another instance's
  invalidation call.

### Why

Fifth item from the 2026-07-09 security audit. The module's own comment already
named this gap: in a horizontally-scaled deployment, a suspended/deleted tenant
could keep working against any API replica that hadn't naturally expired its
30s-TTL local cache entry yet.

### Explicitly not touched

`packages/entity-engine/src/validation/schema-cache.ts` — a separate, CLAUDE.md-
flagged off-limits item ("Schema cache / redis.keys() fix — deferred until load
testing"), unrelated to this fix. Only referenced as a precedent for the
existing `getRedis()` / `redis.status === "ready"` conventions already used
elsewhere in the codebase.

### Verification

- pnpm typecheck: PASS (41/41, after `pnpm install` linked the new
  `@platform/auth → @platform/redis` workspace dependency)
- pnpm lint: PASS (direct eslint run on touched files, clean)
- pnpm test: PASS — `@platform/auth` 35/35 (up from 26, +9 new). Root
  `@platform/api` failures unchanged at the established 12-test baseline.
- pnpm test:isolation: PASS (119/119, genuine re-run — cache miss confirmed
  since apps/api changed)
- Live end-to-end verification against the running stack: rebuilt and
  restarted `ow-backend`, confirmed clean startup with no errors,
  `PUBSUB CHANNELS` on the real Redis container shows the subscriber
  registered on `tenant-status:invalidate`, and a manual `PUBLISH` was
  received (1 subscriber) with no errors in the API logs afterward.

### Next

Remaining items from the 2026-07-09 security audit's to-do list, in order:
1. **#6/#7** Defense-in-depth: `automation-rules` routes via `withTenantContext`;
   `entity-types` mutation statements missing a belt-and-suspenders tenant filter.
2. **#8/#9/#10** Introspection cache hash, `users.ts` PII-exposure design
   confirmation, follow-up audit pass on ~90 unreviewed route files.

### Open questions

- None blocking.
