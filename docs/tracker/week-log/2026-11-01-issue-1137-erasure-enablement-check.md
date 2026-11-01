# 2026-11-01 — #1137 Superset erasure enablement check

**Session type:** Code (3G, #728 follow-up)
**Branch:** `fix/PLAT-1137-superset-erasure-enablement-check`

Owner approved the design on 2026-10-31 (issue comment), including the additive `unverified` erase status.

- **Superset:** `GET /openwind/erasure/status` in the `openwind_erasure` blueprint (service account only):
  `{ stage2, erasure, owsubMarker, version }`. Python tests added to `test_erasure_endpoint.py`.
- **Worker:** `superset-erasure-selfcheck.ts` (first built as an in-process interval; see the 2026-11-01 owner update below): status, comparison with `supersetErasureMode()`, no-op smoke erase for synthetic tenant
  `00000000-0000-4000-8000-00000000de1e`. Result kept in Redis (`ops:superset-erasure:selfcheck`, 30 min TTL),
  shared helpers and the pure resolver in `@platform/redis`. No audit row, no DB write.
- **Fail closed:** `eraseUserInSuperset` (API) and `cleanUpOutsideDatabase` (tenant purge) use the resolver.
  Superset reports Stage 2 on: erase in full regardless of local env. Local "cache-only" with no fresh
  confirmation: API replies `unverified`, tenant purge throws and retries. Local "off" stays `disabled`.
- **Metrics/alerts:** `openwind_superset_erasure_selfcheck_total{outcome}`, gauge
  `openwind_superset_erasure_config_mismatch`; alerts `SupersetErasureConfigMismatch`,
  `SupersetErasureSelfcheckFailing`; `SupersetErasureFailed` now includes `outcome="unverified"`. promtool tests added.
- **Docs:** runbook (new "Enablement self-check" section; the manual `bao kv get` advice replaced), spec D8
  section, CHANGELOG, tracker 3G row.
- **Behaviour change to know about:** a deployment without Superset that leaves `SUPERSET_ERASURE_ENABLED` at its
  default (`true`) now gets `unreachable` self-checks, `unverified` user erases and failing tenant purges. The
  documented setting for such a deployment is `SUPERSET_ERASURE_ENABLED=false`.
- **Not in this PR:** #1138 (durable enqueue/reconciler), #1141, #1139, #1143 (Python tests still do not run in CI).

## Owner update (2026-11-01, same day, on PR #1152)

The owner decided four changes (clean setup, configurability, scale); items 1-3 are built, item 4 skipped.

- **Explicit flag.** `SUPERSET_DEPLOYMENT` (`off` default, `on`) in `@platform/config`, read by API and worker.
  `supersetErasureMode()` is now: off -> `off`; on -> `full` if `SUPERSET_OAUTH_CLIENT_ID` else `cache-only`.
  `SUPERSET_ERASURE_ENABLED` is deprecated and ignored (kept in the schema only as an optional string so
  `supersetConfigWarnings()` can log a startup warning; the same warning for an OAuth id set with the flag
  off). Safety net kept: Superset reporting Stage 2 on overrides a local `off`. With `off` the self-check is
  `skipped` for any failure to ask and when Superset says Stage 2 off, and `mismatch` only when Superset says
  on (no smoke erase then). Cache flush now also follows the resolver (so the safety net flushes too), and
  logs at info when off. `switchIgnored` (existing API field) now means "flag off here but Superset on".
  Compose: `SUPERSET_DEPLOYMENT` on `ow-backend` and `ow-worker`, default `off` in `docker-compose.yml`
  (set in `.env` with `--profile reporting`; compose cannot vary another service's env by profile), default
  `on` in `docker-compose.prod.yml` (the prod stack includes Superset). Added to the prod checker's
  allowed env, not to `BAO_REQUIRED_KEYS` (not a secret). `apps/worker/vitest.config.ts` workaround removed.
- **Scale.** Self-check is a BullMQ repeatable job (`superset-erasure-selfcheck`, `repeat.every`, fixed
  job id, plus a fixed-id `check-on-start` job), same shape as `zitadel-key-expiry.ts`. Interval and Redis TTL
  are `SUPERSET_SELFCHECK_INTERVAL_MINUTES` (15) / `SUPERSET_SELFCHECK_TTL_MINUTES` (30, at least twice the
  interval). A changed interval removes the old repeatable at startup (its key includes `every`).
- **Durability hook (no migration).** An `unverified` user erase writes `superset_erasure.failed` (migration 0156) on the user as the system with `metadata {kind:"user", status:"unverified", userId}`. Best effort
  (a failed write is logged). No new audit action, so no migration number was taken.
- **Skipped (follow-up):** self-check status on the platform-admin page. It needs a new platform-admin route
  (MFA/session conventions, tests) plus admin-ui strings in every locale; more than a small read-only endpoint
  and one component.
