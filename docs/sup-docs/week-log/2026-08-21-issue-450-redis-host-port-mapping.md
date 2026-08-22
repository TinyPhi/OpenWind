## 2026-08-21 — Issue #450: Redis host port mapping for host-mode testing

**Session type:** Bug fix / infra
**Branch:** `chore/PLAT-450-redis-host-port-mapping`

### Completed this session

#### Issue #450 (apps/api host-mode `pnpm test` failed 14 tests — Redis had no host port mapping)

- `docker-compose.yml`: added a loopback-only host port mapping to the `redis` service —
  `127.0.0.1:${REDIS_HOST_PORT:-6379}:6379` — mirroring `postgres`'s existing
  `POSTGRES_HOST_PORT` pattern. Loopback-only (not `0.0.0.0`), since redis has no
  `requirepass`/ACL configured anywhere in this stack.
- Documented `REDIS_HOST_PORT` in `.env.example` (matching `POSTGRES_HOST_PORT`/
  `ADMIN_UI_HOST_PORT`'s existing style) and `docs/local-setup.md`'s port-conflict
  troubleshooting section and services-reference table.
- Verified against the real docker stack: `docker port ow-cache` confirms `127.0.0.1:6379`
  (not `0.0.0.0`); all 14 originally-failing tests (`upload-flow.test.ts`,
  `quarantine-flow.test.ts`, the automation-engine isolation suite) now pass, individually and
  as a batch (405/405 across `tests/isolation`+`tests/integration`).
- `/review` fanned out into a large multi-agent pass and surfaced a genuine security trade-off:
  loopback binding on an unauthenticated Redis, on a host the issue's own rationale describes
  as shared with other projects, trades "unreachable from anywhere outside the Docker network"
  for "reachable by any other local process/user on the same machine." Presented this to the
  human rather than deciding alone (crosses into architecture/security territory) — decision:
  ship loopback-only as-is, since this matches the codebase's existing security posture
  elsewhere (openbao's `0.0.0.0` exposure + hardcoded dev root token, postgres's committed dev
  password) rather than introducing a new class of risk.
- Fixed two now-stale claims the same review surfaced: a comment in
  `api-key-auth.isolation.test.ts` and a frozen spec-log row in
  `docs/specs/tenant-scoped-rate-limit-195.md` both asserted "Redis has no host port mapping by
  design" — corrected the test comment, annotated (not rewritten) the frozen spec row.
- Added a `CHANGELOG.md` entry (git-conventions.md's PR checklist requires one for user-facing
  changes; direct precedent already exists for `POSTGRES_HOST_PORT`/`ADMIN_UI_HOST_PORT`).
- Filed two follow-ups surfaced by the same review, kept out of this PR's scope: #454
  (postgres's own host mapping binds `0.0.0.0`, no loopback restriction — same gap class, a
  different, more central service, deserves its own reviewed change) and #455 (openbao — worse
  than Redis: a secrets manager, dev-mode, hardcoded root token, already `0.0.0.0`-exposed).
- Also noted, not fixed (same class of gap `POSTGRES_HOST_PORT`/`MIGRATION_DATABASE_URL`
  already has): overriding `REDIS_HOST_PORT` to a non-default port doesn't cascade to
  `REDIS_URL`, which stays whatever host-mode tooling has it hardcoded to. Documented in
  `.env.example`, not fixed — the realistic default case (no collision) works out of the box.

### Verification

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- `docker compose config --quiet`: PASS
- `docker port ow-cache`: confirms `127.0.0.1:6379` (loopback-only, not network-wide)
- `apps/api` full `tests/isolation` + `tests/integration` suite (host-mode): 405/405 pass
