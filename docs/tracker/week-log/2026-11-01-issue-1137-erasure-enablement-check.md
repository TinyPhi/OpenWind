# 2026-11-01 — #1137 Superset erasure enablement check

**Session type:** Code (3G, #728 follow-up)
**Branch:** `fix/PLAT-1137-superset-erasure-enablement-check`

Owner approved the design on 2026-10-31 (issue comment), including the additive `unverified` erase status.

- **Superset:** `GET /openwind/erasure/status` in the `openwind_erasure` blueprint (service account only):
  `{ stage2, erasure, owsubMarker, version }`. Python tests added to `test_erasure_endpoint.py`.
- **Worker:** `superset-erasure-selfcheck.ts` (startup + every 15 min, in-process interval, not a BullMQ
  repeatable): status, comparison with `supersetErasureMode()`, no-op smoke erase for synthetic tenant
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
