# 2026-10-31 — roadmap tracker reconciliation (dedicated sync pass)

**Session type:** Docs, tracker sync
**Branch:** `docs/PLAT-1145-tracker-reconcile`

The tracker rows were last extended 2026-10-23 (header dated 2026-10-26). Every fact below was checked with
`gh pr view`, `gh issue view` or `git log origin/main` on 2026-10-31. Spec task tables were not used as evidence.

- **3E:** added #1103 (on-call team members, roster limited to the team, 2026-10-30). Gaps now: only #570.
  #571 closed 2026-10-12 (#872, #879, #885); T39/T43 merged in #883.
- **3D:** #636 (#945, #1027) and #637 (#1036, #1055) closed 2026-10-20; #640 (#857) closed 2026-10-19;
  #642 (#1043, #1052) closed 2026-10-20; #769 (#906, #907) closed 2026-10-13. #1026 merged the
  breach runbook; #639 is still open. Open GDPR follow-ups: #639, #641, #728.
- **3G:** #1010, #1070, #1074, #1071, #1031, #1100, #1101 merged; new erasure follow-ups #1137-#1143;
  ADR-019 still Proposed.
- **3H:** noted the #691 runbook rewrite is in open PR #1135.
- **Efforts:** sandbox (T15 and the UI slices merged, branding #1077, seed org chart #1067, follow-ups
  closed), my-org-view (#1064, #1073), on-call rotation (PR A #1103 merged, PR B #1114 open), org
  directory (#1065, #1066, #1068; #1115 open), i18n (#1102, #1107 merged).
- **CLAUDE.md track table:** 3E and 3F headlines no longer list closed gaps (#571, #580, duration metrics).
- **Open Tickets:** 87 open on GitHub; 10 issues (#930, #931, #1080, #1085-#1088, #1090, #1091, #1093) are
  being closed by the owner in the same session and are left out, so 77 rows. 48 closed rows dropped,
  41 missing rows added.
- **Not recorded:** open PRs #1130, #1134, #1135, #1136, #1144 appear only where they belong to a listed
  effort or issue (#1135 under 3H, #1130 and #1144 in the Notes of #1078 and #1079). The tracker has an `Open`
  column only on the efforts table, so no new column was added.

**Previous tracker header, preserved verbatim:**

> **Last updated:** 2026-10-26 — multi-lingual UI (#200): spec approved, ADR-024 filed to docs/decisions/. Earlier: 2026-10-09 — dedicated sync pass: 3D/3F/3G rows extended from merged PRs, two spec-driven efforts outside the track table (org-directory, multi-org sandbox) added, scorecard noted, Open Tickets regenerated (84 open; 28 closed rows dropped, 44 missing rows added). Earlier header history moved verbatim to
> [week-log/2026-10-09-tracker-reconcile.md](week-log/2026-10-09-tracker-reconcile.md) and
> [week-log/2026-09-27-doc-audit-reconciliation.md](week-log/2026-09-27-doc-audit-reconciliation.md).
