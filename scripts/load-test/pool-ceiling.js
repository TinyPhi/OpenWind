// pool-ceiling.js — k6 script for issue #296 (Postgres connection pool ceiling).
//
// Simulates N concurrent virtual users issuing sustained authenticated GET
// traffic against a DB-touching route, to observe whether DATABASE_POOL_MAX
// (app-side) or PgBouncer's DEFAULT_POOL_SIZE saturates first — see
// scripts/load-test/README.md for how to capture pg_stat_activity / SHOW POOLS
// alongside a run, and for the "why one shared token" caveat on what this
// script does and does not test.
//
// Run (from repo root, with the docker compose stack up):
//   TOKEN=$(node scripts/load-test/get-dev-token.mjs) \
//   docker run --rm -i --network host \
//     -e TOKEN -e BASE_URL -e TENANTS -e RPS_PER_TENANT -e DURATION \
//     -v "$(pwd)/scripts/load-test:/scripts" \
//     grafana/k6 run /scripts/pool-ceiling.js
//
// All of TENANTS/RPS_PER_TENANT/DURATION/BASE_URL are optional — defaults
// below are the provisional #296 placeholder target (20 tenants x 5 req/s,
// 5 minutes), NOT a product requirement. See docs/specs/pool-load-test-tooling.md §C.

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TENANTS = parseInt(__ENV.TENANTS || "20", 10); // PROVISIONAL — see README
const RPS_PER_TENANT = parseFloat(__ENV.RPS_PER_TENANT || "5"); // PROVISIONAL
const DURATION = __ENV.DURATION || "5m"; // PROVISIONAL
const TOKEN = __ENV.TOKEN;

if (!TOKEN) {
  throw new Error(
    "TOKEN env var is required — mint one with `node scripts/load-test/get-dev-token.mjs` " +
      "and pass it through (see this file's header comment for the full run command).",
  );
}

export const options = {
  // k6's default trend stats (avg/min/med/max/p(90)/p(95)) don't include
  // p(50) — explicitly requesting it here avoids handleSummary crashing on
  // an undefined value (found via a smoke-test run against a live stack).
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    pool_ceiling: {
      executor: "constant-arrival-rate",
      // Each "tenant" is modeled as one arrival stream at RPS_PER_TENANT;
      // total target rate is tenants x rps-per-tenant. See the "why one
      // shared token" note in README.md — this measures request concurrency
      // against the connection pool, not per-tenant RLS query-path behavior.
      rate: TENANTS * RPS_PER_TENANT,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: TENANTS * 2,
      maxVUs: TENANTS * 4,
    },
  },
  thresholds: {
    // Always-passing sentinel (rate<1 means <100% error rate) — only here to
    // surface http_req_failed in the summary output, not as a real pass/fail
    // gate. Use rate<0.01 if you want a meaningful 1%-error threshold.
    http_req_failed: ["rate<1"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/entity-types`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  check(res, {
    "status is 200": (r) => r.status === 200,
    "not pool-exhaustion 5xx": (r) => r.status < 500,
  });
  sleep(0); // constant-arrival-rate executor paces requests; no extra sleep needed
}

export function handleSummary(data) {
  const p50 = data.metrics.http_req_duration.values["p(50)"];
  const p95 = data.metrics.http_req_duration.values["p(95)"];
  const failed = data.metrics.http_req_failed.values.rate;
  console.log(
    `\n== pool-ceiling summary (PROVISIONAL target: ${TENANTS} tenants x ${RPS_PER_TENANT} req/s, ${DURATION}) ==\n` +
      `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms error_rate=${(failed * 100).toFixed(2)}%\n` +
      `Cross-reference this against pg_stat_activity / SHOW POOLS captured during the same window — see README.md.\n`,
  );
  return { stdout: JSON.stringify(data, null, 2) };
}
