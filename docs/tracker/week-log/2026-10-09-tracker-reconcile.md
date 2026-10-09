# 2026-10-09 — roadmap tracker reconciliation (dedicated sync pass)

**Session type:** Docs, tracker sync
**Branch:** `docs/PLAT-tracker-reconcile-2026-10-09`

The tracker was last updated 2026-09-28. Since then 75 PRs merged, and two spec-driven efforts that
account for about a third of them (org-directory and the multi-org sandbox) did not appear in it at all.
Every status below comes from merged and open PRs and from `closingIssuesReferences`, not from the specs'
own task tables, which are stale (the org-directory table still says `todo` throughout).

- **3D:** added #766 (closes #689), #759 (closes #692, #693) and #787 (closes #697); refreshed the open
  GDPR follow-up list (#636, #637, #639–#642, #769, #728).
- **3F:** added the schedule-rules UI follow-ups: #741 (closes #631), #742 (closes #633), #737, #715,
  #738, #739.
- **3G:** added the Superset hardening PRs #790, #798 (closes #716), #799 (closes #709) and #809 (closes
  #806, #807); #708 and #709 are closed; ADR-019 is still `Proposed`; listed the open review follow-ups.
- **New section, "Spec-driven efforts outside the track table":** org-directory (PR1–PR5 merged) and the
  multi-org sandbox (phases 1–2 and T9–T14 merged; T15 #838 changes requested, with #839, #841 and #842
  approved but stacked on it). No track ID was invented; assigning one is an owner call. The scorecard
  notes the two efforts but its numbers are unchanged.
- **Open Tickets by Creator:** regenerated from `gh issue list` (84 open). 28 rows for closed issues were
  dropped and 44 missing rows added, each with an Area and Notes entry. The six admin-ui follow-ups from
  Rahul's refactor PRs (#789, #810, #825, #843, #849, #850) and #724 (Tushar's #711) now show their
  assignees.

**Not changed here (human or owner call):** `CLAUDE.md` still lists the Phase 3 track table without
these two efforts and still says async exports use S3 (#697, closed by #787). Both are worth a one-line
fix by a human.

**Previous tracker header, preserved verbatim:**

> **Last updated:**2026-09-28 — 3D/3H rows updated for #681, #687, #690 and #680 merging; Open Tickets
> regenerated (68 open). 2026-09-27: 3E/3F/3G/3A rows reconciled against merged PRs (#694). Earlier header history moved verbatim to
> [week-log/2026-09-27-doc-audit-reconciliation.md](week-log/2026-09-27-doc-audit-reconciliation.md).
