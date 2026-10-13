# 2026-10-12 — Scheduler alert rules (#580 T11)

**Session type:** Code
**Branch:** `feat/PLAT-580-schedule-alert-rules`

- Added the three alerts from `docs/temporal-scheduler-design.md` §9.4 to
  `docker/observability/alert.rules.yml`: `ScheduleExecutionFailureRateHigh`,
  `ScheduleTickDurationSLOBreach` and `ScheduleExecutionDurationSLOBreach`.
- Two of the three read duration histograms that were never registered (only the three counters
  existed), which is why the rules were never written. Registered
  `openwind_schedule_tick_duration_ms` and `openwind_schedule_execution_duration_ms` and recorded
  them in `schedule-tick-worker.ts`: the tick duration once per tick on both the completed and the
  failed path, the execution duration once per fire attempt on both paths (catch-up fires reuse
  `fireRule`). The execution histogram is labelled by status only; the error code stays on the
  counter, and tenant and rule ids are not labels, to keep the series count bounded.
- **Two corrections to the design's rule text.** The design writes
  `histogram_quantile(0.99, openwind_schedule_tick_duration_ms)`, which is not valid PromQL; a
  quantile needs `sum by (le) (rate(..._bucket[5m]))`. And the rules live in
  `alert.rules.yml`, not `prometheus/alerts/schedule.yml`.
- **A rule that could never fire.** With OpenTelemetry's default histogram boundaries the top finite
  bucket is 10000. A fire slower than 10 s lands only in `+Inf`, and `histogram_quantile` returns
  the top finite bound at most, so `p99 > 10000` is never true. Confirmed by running the pinned OTel
  SDK and Prometheus serializer (default buckets stop at `le="10000"`, with the 12 s observations
  all in `+Inf`) and by a `promtool` case. Both histograms now use explicit boundaries to 60 s via
  `advice.explicitBucketBoundaries` (honoured by the pinned `sdk-metrics`). The boundaries live in
  `packages/telemetry/src/schedule-duration-buckets.ts`, with a test that keeps a finite bucket above
  the largest alert threshold.
- **Verification beyond unit tests.** `promtool check rules` passes (9 rules). New
  `docker/observability/alert.rules.test.yml` has 15 `promtool test rules` cases: each alert fires on
  the right series and stays quiet on the right one, thresholds are bracketed (9% quiet, 12% alerts),
  an idle scheduler and a missing failed series stay quiet, and the overflow case is documented both
  ways (default buckets cannot alert, the scheduler buckets can). Eight mutations of the rules file
  (each window, each threshold, the quantile, `for`, the selector) each fail at least one case. CI
  does not run that file (the workflow files are off-limits to me); the command is in its header.
- **Drift guard.** `packages/telemetry/src/alert-rules.test.ts` fails when any series read by a rule
  is not exposed by what `metrics.ts` registers. It covers every registered metric family
  (`openwind_`, `http_`, `bullmq_`, `billing_`), and ignores comments in `metrics.ts`, so a
  commented-out registration does not count. There was no such check, which is how a rule came to
  reference a metric that did not exist. Checked by mutation: renaming a referenced series, renaming
  a registered histogram, a typo on a `billing_` series, a commented-out registration, and dropping
  the top bucket each fail it. It does not check label matchers (a `{status="failed"}` against a
  counter with no `status` label would pass).
- **Review (two lenses, findings checked by running promtool and the tests):**
  - _Fixed:_ the execution duration rule used a 5m window with `for: 5m`. A fire is recorded only
    when a rule is due, so with fires hours apart an isolated slow fire is in the window for about
    five evaluations and `for: 5m` is never met; the alert was effectively dead. Verified, then the
    window is now 15m (the tick rule stays 5m: a tick runs every minute). A test pins it.
  - _Fixed:_ the catch-up worker test did not prove catch-up ran; it now asserts the catch-up counter
    and more than one fire. The 10m failure-rate window was untested (changing it to 1m passed);
    it is now pinned. Drift-guard hardening above. An ADR-015 citation for "tenant is not a label" was
    unsupported (ADR-015 has no label rule) and is removed.
  - _Kept by design, so the next reader does not re-litigate it:_ there is no minimum-traffic floor on
    the failure-rate rule. One failure among five fires alerts at 20%. A schedule that fires a few
    times an hour has no other way to alert, and a failed fire is a ticket that was not created.
    A test locks this in.
  - _Known limitation:_ the first-ever failure for an `errorCode` is invisible to `rate()` (a counter
    series that first appears at 1 has no earlier sample to rate against). Inherent to counters;
    later failures alert normally.
- **Not done, and not required by #580:** the six Grafana panels and the active-rules-by-tenant
  gauge from §9.4. Whether 3F counts as done without them is an owner call.
- #580 and #582 were assigned in a 2026-09-30 comment but had no assignee and no branch; reassigned
  with a comment to the assignee named there.
- **Approval review (PrabhuVijit; five non-blocking suggestions and two test gaps, all handled in one commit):**
  - _A, fixed:_ a failed fire's duration included the DB writes that record the failure. The clock now
    stops at the failure, before that bookkeeping, so a failed sample measures the fire attempt as a
    successful one does (the same choice made for the on-call dispatch histogram). A deterministic clock
    test (300 ms attempt, 700 ms bookkeeping) pins it. Writing that test caught my own mistake: a fake
    clock starting at 1970 made the rule look overdue, so the fire was skipped and nothing was recorded.
  - _B, tracked:_ `alert.rules.test.yml` still is not run by CI (workflow files are off-limits to me).
    Added `pnpm test:alerts` (runs `promtool check rules` and `test rules` through Docker) so the check
    is one command, and filed #881 to gate it in CI.
  - _C, kept, now documented:_ the execution-duration alert counts success and failure together on
    purpose. The SLO is how long a fire takes, and a fire that hangs for 30 s and then fails is what it
    should catch; it can fire alongside the failure-rate alert. Comment added in the rules file.
  - _D, kept, now explained:_ `humanizePercentage` because the value is a 0-1 fraction; the HTTP rules
    multiply by 100 and use `printf`. Comment added.
  - _E, fixed:_ the bucket test hardcoded `10_000` as the largest threshold. It now reads the thresholds
    from the rules file, asserts there are exactly two, that the top bucket is above the largest, and
    that each threshold is itself a bucket boundary, so a new or changed alert cannot outrun the buckets.
  - _Test gaps, fixed:_ catch-up fires that fail now have their own test (each records a failed
    duration), and the failure test asserts the value is non-negative. Mutation-checked against a clean
    baseline: the pre-fix timing fails 1 test, dropping failed durations fails 3, and a threshold above
    the top bucket or off a boundary fails 2 and 1.
