# Pool ceiling load-test tooling (issue #296)

Tooling to observe whether `DATABASE_POOL_MAX` (app-side, default 10) or PgBouncer's
`DEFAULT_POOL_SIZE` (20) saturates first under concurrent load — the question issue #296
says can't be answered by reading code alone. **This directory builds the tooling and
records one exploratory run against the dev stack. It does not pick a final production
pool size** — that needs a real concurrency target and a production-like data volume,
both future work. See `docs/specs/pool-load-test-tooling.md`.

## What "concurrent tenants" means here (read this first)

The k6 script models load as N concurrent virtual users, each issuing authenticated GET
traffic. It does **not** use N distinct per-tenant Zitadel tokens. Why: in this dev stack,
`NODE_ENV !== "production"` forces every valid JWT's `tenantId` to `env.DEV_TENANT_ID`
regardless of which Zitadel org signed it (`packages/auth/src/jwks.ts`) — there is no
per-request tenant override. Building real multi-org Zitadel provisioning just to get
distinct tokens would be a new feature, not load-test tooling (see
`docs/specs/pool-load-test-tooling.md` §B for the decision).

**Consequence:** this measures genuine DB/connection-pool contention under concurrent
request volume (the actual #296 question) — it does **not** exercise per-tenant RLS
query-path differences, since every request lands on the same dev tenant. If a future
sizing decision needs that fidelity, it needs real per-tenant provisioning first.

## Prerequisites

- `docker compose up -d` running (at minimum `postgres`, `pgbouncer`, `ow-backend`; add
  `ow-worker` if also running the backlog scenario).
- Docker available to run `grafana/k6` (no pnpm devDep added — see the spec's invariant on
  keeping load-test tooling out of the JS workspace/lockfile).
- Zitadel bootstrapped (`ZITADEL_KEY_JSON` present in `.env.local` — the same credential
  `pnpm bootstrap`/`scripts/setup-dev-auth.ts` already sets up).

## 1. Mint a token

```bash
TOKEN=$(node scripts/load-test/get-dev-token.mjs)
```

## 2. Run the k6 script

```bash
docker run --rm -i --network host \
  -e TOKEN -e BASE_URL="http://localhost:3000" \
  -e TENANTS=20 -e RPS_PER_TENANT=5 -e DURATION=5m \
  -v "$(pwd)/scripts/load-test:/scripts" \
  grafana/k6 run /scripts/pool-ceiling.js
```

`TENANTS=20 RPS_PER_TENANT=5 DURATION=5m` is the **provisional placeholder target** —
not a product requirement. Adjust once a real concurrency number exists.

`--network host` only works on Linux; on macOS/OrbStack, use
`-e BASE_URL="http://host.docker.internal:3000"` instead (or run k6 directly if you have
it installed locally, pointing at `localhost:3000`).

## 3. Capture pool state during the run (in separate terminals, while step 2 runs)

**Postgres connection count**, polled every few seconds:

```bash
watch -n 3 'docker compose exec -T postgres psql -U platform -d platform -c \
  "SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2 ORDER BY 1,2;"'
```

**PgBouncer pool state**, polled every few seconds:

```bash
watch -n 3 'docker compose exec -T pgbouncer psql -h localhost -p 5432 -U platform pgbouncer -c "SHOW POOLS;"'
```

Note which ceiling (app-side `DATABASE_POOL_MAX=10` × number of app processes, or
PgBouncer's `DEFAULT_POOL_SIZE=20`) is reached first — that's the actual bottleneck, not
necessarily the one that's easiest to bump.

## 4. Optional: worker-poller backlog scenario

`ow-worker` and `ow-backend` share the same PgBouncer pool budget. To see whether worker
contention measurably degrades API latency (or vice versa), inject synthetic backlog
before/during the k6 run:

```bash
./scripts/load-test/inject-outbox-backlog.sh 5000     # insert 5,000 synthetic rows
# ... run the k6 script from step 2 concurrently ...
./scripts/load-test/inject-outbox-backlog.sh --cleanup  # remove exactly those rows
```

**Note on outbox-poller behavior with synthetic rows:** the outbox-poller reads events
where `deliveredAt IS NULL` and marks them delivered as it processes them. The synthetic
`loadtest.synthetic_backlog` event type has no registered automation handler, so the
poller marks these rows delivered immediately without doing any real work — the backlog
will drain in seconds under a running `ow-worker`, providing less sustained pool pressure
than a real handler backlog would. This is still useful for observing peak pool contention
at the moment the poller batch runs, but don't expect it to hold the worker under load for
the full k6 duration. If sustained worker pressure is needed, pause `ow-worker` before
injecting, then start it once the k6 run is underway.

## 5. Write up the results

Copy the previous run's file under `docs/sup-docs/load-test-results/` as a template and
record: p50/p95 latency, max observed connections per process, which pool ceiling
saturated first, and the exact load profile used. State the provisional-target and
dev-scale-data caveats in the first paragraph — this is a baseline for the next person to
build on, not a sizing recommendation.
