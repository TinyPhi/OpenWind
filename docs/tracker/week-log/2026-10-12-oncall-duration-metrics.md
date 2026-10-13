# 2026-10-12 — On-call duration metrics and the resolution SLO alert (#570 T39, #571 T43)

**Session type:** Code
**Branch:** `feat/PLAT-570-oncall-duration-metrics`, stacked on `feat/PLAT-580-schedule-alert-rules` (#867)

- Registered the three T39 metrics the design lists: `openwind_oncall_resolution_duration_seconds`,
  `openwind_notification_dispatch_duration_seconds` and `openwind_notification_policy_match_total`.
- **resolve_oncall.** The four sites that increment `openwind_oncall_resolutions_total` now go through
  one helper that also records the duration, so the histogram's count always equals the counter's sum.
  Early returns that record no counter (team did not change, bogus team, idempotent replay) record no
  duration. The duration runs from the action's entry to the moment the outcome is recorded. The label
  is `outcome`, matching the implemented counter (the design says `result`).
- **dispatch_severity_notification.** One duration per channel, measured after the recipient loop and
  before the failure audit write so an ok and a failed channel are timed over the same work. The
  policy-match counter is incremented once per dispatch actually performed, after the idempotency claim,
  so a re-delivered event is not counted twice; `team+workflow` and `hardcoded-default` are normalised
  to the design's `team_workflow` and `hardcoded_default`.
- **Second-scale buckets.** OTel's default boundaries (0, 5, 10 ... 10000) are millisecond-scale. A
  histogram recorded in seconds with them puts every sub-5 s observation in `le="5"`, so every
  quantile reads about 5 s. Both histograms get explicit boundaries (1 ms to 5 s for resolution,
  10 ms to 30 s for dispatch) with a finite bucket above each SLO threshold (0.1 s, 2 s), so a p99 over
  the SLO is observable. A `promtool` case shows the failure: with default buckets a fast resolution
  reads as p99 = 4.95 s and would page.
- **`OncallResolutionSLOBreached`** (#571 T43, deferred until this histogram existed) added to
  `alert.rules.yml`: p99 > 0.1 s, `sum by (le) (rate(...[15m]))`, `for: 5m`. The window is 15m for the
  reason found on #867: a resolution is recorded only when a ticket's team changes, so they can be
  hours apart, and a 5m window leaves one slow resolution in range for fewer than the `for` duration.
  Five new `promtool` cases (20 in the file) (fires, quiet, sparse, idle, the default-bucket trap); mutations of the
  window, threshold, quantile and `for` each fail a case.
- **Tests.** 21 new action tests: each resolve outcome mirrors the counter with only the `outcome`
  label, the three no-op paths record nothing, each `matched_at` value, idempotent replay and
  no-recipient paths record nothing, per-channel durations, and deterministic duration checks through a
  spied clock (0.45 s resolution across three lookups, 0.2 s / 0.1 s for two channels). Mutation-checked:
  dropping the histogram, adding a label, starting the timer late, counting the policy before the
  idempotency claim, not normalising `matched_at`, skipping the failed channel and sharing one timer
  across channels each fail a test. The first version of the resolution timing test missed a late timer start because its fake clock only advanced at the schedule lookup; it now advances at the team lookup too, and review then found that only the no-schedule path was clock-tested, so each of the other three recording sites (skipped explicit assignee, cascade-assigned, cascade-exhausted) now has its own deterministic clock test; a fresh timer at any one of them fails exactly one test.
- **Found, not changed:** the existing `http_request_duration_seconds` histogram has the same
  millisecond-scale-buckets problem (recorded in seconds, default boundaries). A `promtool` case
  shows `HttpLatencyHigh` reading "P95 ... 4.75s" and firing when every request takes 50 ms. This
  assumes the production exporter uses the SDK defaults (no View sets boundaries); I did not run it
  against a live process. Out of scope here; reported to the owner.
- **Not in this PR:** the Grafana panels (T42), `openwind_label_assignment_total`, #570 T29
  (SMS/WhatsApp/voice delivery) and #571 T19/T33 (the two UI badges).
- **Review (security and correctness lenses; findings checked against the code or the live schema):**
  - _Fixed:_ a wrong figure in a promtool comment (4.75 s, which is the p95 case, for the p99 case's
    4.95 s) and the three unpinned timing sites above.
  - _Refuted:_ the security review's one low point, that `channel` reaches a label without a runtime
    allowlist. `notification_policies` has `CHECK (channels <@ ARRAY['email','sms','whatsapp','call'])`
    on the live schema (migration 0099) and the API validates the same enum, so the label is bounded at
    two layers. The same label already existed on `openwind_notification_dispatch_total`.
  - _Known limitations, not changed:_ (1) the first observation after a worker restart or deploy is
    invisible to `rate()` (a cumulative series first appears at count 1), so the first, possibly
    coldest, resolution after a restart cannot alert; the scheduler's duration alerts share this.
    (2) A dispatch with no recipients returns before the policy-match counter, so it is not counted
    (a tenant with no policy and unassigned tickets does not show up in the `hardcoded_default` share
    the design wants to watch). (3) The policy-match counter is incremented just before
    `isOutboundNotificationsEnabled()`, so if that call throws, one match is counted with no dispatch.
  - The resolution duration covers the whole action (team lookup, claim, assignment and audit write),
    so the 100 ms SLO is measured strictly against the action, as the design states it.
