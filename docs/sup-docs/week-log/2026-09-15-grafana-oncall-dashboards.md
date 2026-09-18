## 2026-09-15 — On-Call Routing Grafana dashboard + alerts

**Session type:** Implementation — observability config only (JSON/YAML, no TypeScript)
**Branch:** `feat/PLAT-613-tagsev-3e-grafana-dashboards` (PR 13, final PR of the tagsev/3E+3F
stack), branched off the still-unmerged `feat/PLAT-608-tagsev-3e-dispatch-severity-notification`
(PR #600) since that branch has the most complete set of on-call-routing Prometheus metrics
registered among the currently open branches.

### Context

Closing out docs/oncall-routing-design.md §9.4 (T42: Grafana dashboard, T43: Prometheus alerts).

### Scope finding: T39 is only partially done

docs/oncall-routing-design.md §9.2 specifies 6 new metrics. Checking every currently-open
tagsev branch's `packages/telemetry/src/metrics.ts`, only 3 are registered anywhere:

- `openwind_oncall_resolutions_total` (counter) — PR #597
- `openwind_notification_dispatch_total` (counter) — PR #600
- `openwind_oncall_coverage_gap_teams` (gauge) — PR #597

Never registered on any branch:

- `openwind_oncall_resolution_duration_seconds` (histogram)
- `openwind_notification_dispatch_duration_seconds` (histogram)
- `openwind_notification_policy_match_total` (counter)
- `openwind_label_assignment_total` (counter)

Rather than ship dashboard panels or alert rules referencing Prometheus series that don't
exist, this PR is scoped to only the 3 metrics that are real. The design doc's remaining 3
panels (Resolution p99 Latency, Notification Dispatch Latency p99, Policy Match Distribution)
and 1 alert (`OncallResolutionSLOBreached`) are deferred — completing T39 with the missing
histograms/counters is tracked as follow-up work, not silently dropped.

### What was produced

- `docker/observability/grafana/dashboards/openwind-dashboard.json` — 3 new panels (ids 9-11):
  On-Call Resolution Rate, Notification Channel Success Rate, Coverage Gaps (live).
- `docker/observability/alert.rules.yml` — 2 new alerts added to the existing `openwind-alerts`
  group: `OncallCoverageGapsDetected`, `NotificationChannelHighFailureRate`.
- `packages/telemetry/src/observability-config.test.ts` — extended the existing dashboard/alert
  assertions to cover the new panels and alerts.

### Verification

- `pnpm --filter @platform/telemetry typecheck`: PASS
- `pnpm --filter @platform/telemetry lint`: PASS
- `pnpm --filter @platform/telemetry test`: PASS (3 files, 22 tests)
- Dashboard JSON parses and re-serializes cleanly (11 panels total); alert rules YAML parses
  cleanly (6 rules total in the group).

### Follow-up (not this PR)

- Register the 2 missing histograms + `policy_match_total`/`label_assignment_total` counters
  (completes T39), then add the corresponding 3 dashboard panels + 1 alert rule.
