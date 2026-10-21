# 2026-10-19 — #1013: split Redis into a queue/state and a cache instance

- `docker-compose.yml`: `redis` is now `noeviction` with AOF (1 GB); new `redis-cache` (256 MB, LRU, no
  persistence, no host port). Backend and worker get `REDIS_CACHE_URL` and wait for both. The flags were
  checked on throwaway containers (`CONFIG GET`), without touching the running stack.
- `docker-compose.prod.yml` and the prod compose check: same wiring; `redis-cache` and `REDIS_CACHE_URL`
  are on the non-secret allowlist, and a published cache port fails the check.
- `@platform/config`: optional `REDIS_CACHE_URL`. `@platform/redis`: `getCacheRedis()` (same client as
  `getRedis()` when unset), `closeRedis()` closes both, `getRedis()` warns once in production when no cache
  instance is set.
- Docs: `docs/deployment-hardening.md` (new Redis section, go-live item), `.env.example`.
- Why it is thin in code: only the entity schema cache is a pure cache, and its file is off-limits to
  agents (schema cache / `redis.keys()` fix is deferred to load testing, #4).

## For PrabhuVijit

- Write the ADR for the queue/state vs cache topology (ADR files are human-only).
- Repoint `packages/entity-engine/src/validation/schema-cache.ts` from `getRedis()` to `getCacheRedis()`
  (one import and three call sites). Until then the schema cache stays on the noeviction instance, with a
  60 s TTL, so it is bounded.
- Decide on moving the Superset result cache (db 2) to `redis-cache` (#728).
