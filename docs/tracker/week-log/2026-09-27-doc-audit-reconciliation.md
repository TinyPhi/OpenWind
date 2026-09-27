# 2026-09-27 — Doc audit: status reconciliation, agent-context dedupe, spec index (#694)

**Session type:** Docs hygiene
**Issue:** #694
**Branch:** `docs/PLAT-694-doc-audit-reconciliation`

A full audit of all ~185 markdown files (tracked docs plus the local-only `docs/sup-docs/`)
found that "what's shipped" was recorded by hand in four places — `CLAUDE.md`,
`roadmap-tracker.md`, `VISION.md` and the spec headers — and all four had drifted. Every
correction below was checked against `gh pr view` / `gh issue view` or the code, not taken from
the audit agents alone.

## What changed

- **Status.** The 3E/3F rows listed #595/#597/#600/#601/#603/#605 as "in review" although all
  merged between 09-16 and 09-18. #602 and #604 were superseded by #623 and #624, which the
  tracker never mentioned. 3G read "spec in review, nothing shipped", but #663–#671 merged on
  09-25. 3E and 3F have all four phases merged, but task-level verification found gaps, so they sit at 90% and 95%. 3G is at 90% (isolation ADR outstanding), and 3A is
  at 50% (partner API Phases A–G all merged). The scorecard was recomputed at about 60%. The
  Open Tickets table was regenerated with 75 open issues (was 43): #102–#105 closed, 36 added.
- **Single source.** `CLAUDE.md`'s track table is now one line per track. PR/issue detail lives
  only in `roadmap-tracker.md`. `VISION.md`'s Phase 3 block, which said 3A–3D were "not
  started", was rewritten the same way.
- **CLAUDE.md** went from 339 lines / ~2,960 words to 168 lines / ~1,200 words (about −60% of
  per-session context). The 17-bullet ADR reference list became one "read before touching" table. The 69-line dependency-pin list had drifted
  from `pnpm-workspace.yaml` (js-yaml 4.3.1 vs 4.3.2, fast-uri 4.1.2 vs 4.1.3, protobufjs
  missing). It is now a pointer, and the few facts only it held (esbuild advisory, postcss
  second advisory, deferred uuid/OTel/react-router-7 advisories) moved into YAML comments.
  Other fixes:
  - Repo layout: added `scheduler`, `telemetry`, `tsconfig`.
  - Commands: Zitadel is a separate compose project, and the `reporting`/`tools`/`bootstrap`
    profiles are now listed.
  - Rules index: now shows the real path scopes.
  - "When stuck" #6 no longer tells agents to write ADRs.
- **Agent rules.** The delivery-flow gate table was stated three times (CLAUDE.md,
  `agent-behaviour.md`, `.claude/README.md`). `.claude/README.md` is now canonical (it gained
  `OPENWIND_PLAN_AUTOPASS`, which it had never mentioned). `agent-behaviour.md` keeps a single
  numbered list. That list fixes a hard-wrapped paragraph that had broken the markdown list, and
  the "parallel approval deferred to Phase 3" wording that contradicted CLAUDE.md.
  `security.md` / `security-reviewer.md` described an "S3 bucket". They now describe the real
  local-disk model: API-streamed downloads after the ACL check, and single-use hashed short-TTL
  upload tokens for the third-party API. The session-start hook pointed at
  `docs/sup-docs/{roadmap-tracker,week-log}.md`; it now points at `docs/tracker/`.
- **Specs.** 23 status headers were wrong (shipped but still draft/review/approved/"not
  committed"), including `modal-a11y-wave2` (#298) and `outbound-notifications-kill-switch`
  (live in `notification-worker.ts`). The status enum is standardised in `/spec`.
  A new `docs/specs/README.md` indexes every spec. The `-tasks.md` companions of 14 shipped specs
  were deleted: none was cited by code, and git and the PR hold the record. The abandoned
  `workflow-id-based-linking` spec and its tasks file were deleted too (owner decision). Five
  tasks files that code cites stay, plus `pool-load-test-tooling-tasks.md`, which still tracks
  deferred work. **Specs are deliberately not moved to an `archive/` folder:** 249
  code/test files cite `docs/specs/<name>.md` paths. The index also lists the ~24 shipped specs
  that PR #619 (`94fbaa2`) deleted while code still cites them, with the `git show` command to
  recover each.
- **Tracker layout.**
  - The frozen `week-log.md` and two bulk-archive files moved to `docs/tracker/week-log/archive/`.
  - Four genuine session logs that PR #659 had put under the gitignored `docs/sup-docs/week-log/`
    moved here; the fifth was a byte-identical duplicate and was removed.
  - Dangling refs fixed: `grafana-oncall.json` (the panels shipped in
    `openwind-dashboard.json` via #605), the ADR-006 draft, and the load-test results path.
  - The dead root `pull_request_template.md` was removed (`.github/` is canonical).
    `CONTRIBUTING.md` now points at it instead of keeping a drifted checklist copy, and stale
    items there were fixed (100 → 600 req/min, a "PR template CLA checkbox" that doesn't exist,
    the `portal` scope).

## Deliberately not done

- ADR-008/009/011 still cite `docs/sup-docs/roadmap-tracker.md` / `phase-timeline.md`, and the
  3G Superset isolation ADR is unwritten. Both are filed as #695 for a human author. The 3H
  module-ownership ADR is #622.
- Issue hygiene: each phase issue's task list was verified against `main`. #567, #578, #579 and
  #581 were closed as shipped (#581's Archive action and pagination are tracked in #631/#633).
  #344, #570, #571, #580 and #582 stay open, each with a comment listing exactly what's left:
  webhook subscriptions, SMS/WhatsApp/voice delivery, duration metrics, two UI badges, and the
  on-call SLO and schedule alert rules.
- PR #687 (`fix/PLAT-638-export-audit-trail`) adds migration `0125_erasure_delete_grants.sql`,
  but `main` already has `0125_normalize_textarea_field_type.sql` — needs a renumber before merge.

## Archived: roadmap-tracker header history (as of 2026-09-18; only the relative link re-pointed)

**Last updated:** 2026-09-18 — Cleanup pass: 3H given its own roadmap row (was previously
untracked here despite #606–613 already existing — see its row below); Phase 3 scorecard
recomputed for 9 tracks (was 8); stale "3C/3D have no ADR yet" line corrected (3D is done, ADR-015
accepted) to name only 3C; Open Tickets table regenerated (43 open, up from 28 at last
regeneration) — added 3H's 8 issues (#606–613), 3C's phased breakdown (#614–618, supersedes the
single #18 tracker row's staleness), and #620/#622; #198's row updated to reflect the 2026-09-18
"keep open" decision (was "closure is a maintainer call," now decided). #192 (backup/DR) removed
from `pending-review-findings.md` as resolved — never listed in this doc's Open Tickets table
since it closed 2026-08-25, before this doc's last regeneration.

**Previously — 2026-08-26** — ADR-012 Phase G ("hardening" closing gate) is now fully
implemented, T1-T12, across three stacked branches/PRs: Phase 1 (T1-T5, rate limiting/JWT
freshness/PII redaction/TLS, PR #495, CI-green), Phase 2 (T6-T7, idempotency-key support, PR
#499, CI-green, stacked on #495), and Phase 3 (T8-T12, access-log retention + tenant-purge
anonymization/deletion + final cross-phase `/security-review`, on `feat/third-party-api-phase-g-retention`,
stacked on #499, not yet a PR). The Phase 3 security review's initial "not ready" verdict (2
blocking findings — missing RLS on the new rollup table, an undocumented R11 resolution) was
resolved in the same session; spec at `docs/specs/third-party-api-phase-g-hardening.md`. Phase E
(status transitions, PR #484) and Phase F (access logs + misuse alerts, PR #489) are both merged
into upstream `main` as of this session's own conflict-resolution merges into #495/#499.
Previously — 2026-08-25 — ADR-012 Phase E (status transitions) PR #484 opened, following
Phase C (#467–#470) and Phase D Stage 1-2 (#472) merging. Reworked 2026-08-24: fully-closed
historical detail tables (Phase 1 carry-overs full list, module-seed detail, pre-Phase-3 hardening
backlog, second consulting-review batch) moved verbatim to
[week-log/2026-08-24-roadmap-tracker-historical-archive.md](archive/2026-08-24-roadmap-tracker-historical-archive.md) —
this doc now tracks **current/open state only**, per its own "How to update this doc" rule below.
