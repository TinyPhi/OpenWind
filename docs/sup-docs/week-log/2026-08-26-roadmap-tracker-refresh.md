# 2026-08-26 — roadmap-tracker.md refresh + ADR-015 accepted

Regenerated `docs/sup-docs/roadmap-tracker.md`'s Open Tickets by Creator table against live
`gh issue list --state open --json number,title,author,createdAt --repo TinyPhi/OpenWind`, and
recorded that ADR-015 (3D — observability + compliance) was accepted.

## Closed since main's last tracker update (removed from the table)

Confirmed via `gh issue view <N> --json state` rather than trusted from the table:

- **#471** — ADR-012 governance process note. Closed 2026-08-24.
- **#455**, **#454** — OpenBao dev-mode exposure / Postgres host-port binding. Closed 2026-08-24.
- **#436** — Flaky isolation tests (outbox-poller-automation-exclusion/-dedup-race). Closed
  2026-08-24.
- **#433**, **#432**, **#431**, **#430**, **#429** — all five ADR-sign-off/backlog items the
  table had already flagged as accepted-but-still-open-on-GitHub; confirmed now actually closed.
- **#403** — Network status awareness discussion. Closed 2026-08-26 — implemented and merged to
  `main` via `feat/PLAT-403-network-status-awareness` (network probe + debounced
  offline/reconnecting banner in admin-ui).

## New issues added

**#490–#498** — nine review follow-ups filed 2026-08-26 against PR #489 (ADR-012 Phase F,
third-party API access-logs screen, merged same day): a TOCTOU access-check gap, two test-hygiene
items (cross-test state dependencies, a missing `tenant_id` filter in a test helper), a
rate-limiting coverage question, a sanitization confirmation, and three N-0x nits (Redis
atomicity, a dangling timeout, non-apikey `userId` handling). Two are already being worked on open
PRs #495 (hardening) and #499 (idempotency-key support) per their branch names — the rest have no
PR yet.

## 3A row note update

Added Phase F (PR #489, merged 2026-08-26) and in-progress Phase G (PRs #495/#499) to the 3A
summary row's status text. Left the 40% estimate unchanged — no solid basis yet to recompute it
against the new Phase F/G scope.

## 3D — ADR-015 accepted

Issue #19's 2026-08-19 review comment asked for a human-authored ADR settling four questions
(self-hosted vs. pluggable observability backend, `tenant_usage` table shape, scope
reconciliation with #6, billing/plan enforcement design) before implementation starts. Claude Code
researched the codebase and produced a draft with recommendations
(`docs/reviews/adr-drafts/ADR-015-observability-compliance-DRAFT.md`, later removed once
finalized); @ab reviewed, made two product calls (error tracking must be pluggable across
Sentry/GlitchTip/Bugsink/none rather than fixed to one vendor; plan-limit enforcement degrades
gracefully per-metric rather than hard-blocking, with the degraded state surfaced via a banner
extending the just-shipped network-status-awareness component plus a Novu notification to tenant
admins), and moved the finalized file to `docs/decisions/ADR-015-observability-compliance.md`.
3D's tracker row updated from "🔴 Not started, no ADR" to "🟡 Design complete, implementation not
started" (5%) — no code has been written yet, only the design record.

**Not done in this refresh:** the Summary scorecard's Phase 3 row still says "3C/3D/3-OPS not
started — no ADR yet for either" — deliberately left alone per the tracker's own rule 4
(parallel-track branches edit only their own row, not the scorecard); needs reconciliation in a
dedicated sync pass now that 3D has a design record.

## PR #501 review follow-up

PrabhuVijit's review of PR #501 (approved with comments) raised 5 findings. F-05 (re-verify the
10 removed issues' `stateReason`, not just `state`) was addressed by re-checking each via
`gh issue view <N> --json stateReason` — all 10 confirmed `COMPLETED`, none `NOT_PLANNED`, so no
tracker change was needed. F-04 (issue #6 partially absorbed by ADR-015 but not annotated) was
addressed: the 3-OPS row and #6's Open Tickets row now note that GDPR-per-user-erasure and
IP-allowlisting moved to ADR-015, leaving DR/backup, Redis SPOF, data residency, and
plugin-marketplace security under #6.

F-01 (ADR-015's `Status: Proposed` should read `Accepted` to match the PR title) and F-03
(`Deciders: Engineering Lead` should name a real person) both require editing
`docs/decisions/ADR-015-observability-compliance.md`, which is protected — Claude Code cannot
write to `docs/decisions/` directly. @ab dictated the exact values (`Status: Accepted`,
`Deciders: Abhinav Mishra`); a corrected full copy was written to
`docs/reviews/adr-drafts/ADR-015-observability-compliance-review-update.md` for @ab to apply
manually. F-02 (explicit confirmation that @ab reviewed and stands behind every ADR-015 decision
as their own judgment, not just an approved plan-lock) is a standing item for @ab to answer
directly on the PR thread — not something this session can state on their behalf.
