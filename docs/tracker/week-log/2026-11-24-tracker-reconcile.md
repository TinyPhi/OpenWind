# 2026-11-24 — Roadmap tracker reconcile

Dedicated sync pass. The tracker header was last updated 2026-10-31 (reconcile #1146). Every claim
below was checked against `gh` (merge dates, closing PRs, open issues) on 2026-11-24.

## Previous header line (moved verbatim)

> **Last updated:** 2026-10-31 — dedicated sync pass: 3D/3E/3G rows and the sandbox, org-view, on-call and i18n efforts extended from merged PRs since 2026-10-09; Open Tickets regenerated (87 open, 77 listed).

## Done

- Rows extended from the 44 PRs merged 2026-11-01 to 11-23: 3D, 3E, 3G, 3H, and the org-directory,
  sandbox, on-call rotation and multi-lingual efforts. The scorecard now says 6 efforts outside the
  table (it said 2).
- Open Tickets regenerated: 42 open, all listed (was 87 open, 77 listed). Closed since 2026-10-31
  and removed from the table include #1137–#1140, #1142, #1143, #1132, #1133, #1076, #1078, #1079,
  #792, #793, #810, #916, #1108, and all the on-call and i18n review children (#1089–#1099, #1116–#1126).
- #1190 (review follow-ups from #1184) added; #611's note corrected (it said blocked on 3E, which has
  merged); #200's note now says every child issue is closed.

## Found

- **#1162 (on-call rotation DST arithmetic) is closed, but its fix is not merged.** #1185's body says
  "Fixes #1161. Does not fix #1162", and GitHub read "fix #1162" in the second sentence as a closing
  keyword: the issue was closed 3 seconds after #1185 merged (2026-11-20). The DST work is in open
  PR #1187, whose review found a one-hour error in `Australia/*` and `Pacific/Auckland` zones on
  transition days. The tracker rows say so; the issue itself was not reopened in this pass (an owner call).
- PR #1182 (#1141) shows `CHANGES_REQUESTED` but its head (`0e5e4a49`) already carries the fixes for
  every must-fix; it is waiting for the reviewer.

## Not done

- No scorecard percentages changed; the track % values are estimates and nothing here moved a track's
  headline. `CLAUDE.md`'s Current focus table was left alone for the same reason.
- `docs/reviews/pending-review-findings.md` still lists #198, #540 and #688, which are no longer
  open. They were not checked individually here; verify before removing the rows.
- Specs' own task tables (org-directory still says `todo` throughout) were not touched.
