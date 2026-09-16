## 2026-09-16 — Tracker reconciliation: 3E/3F actual state, Open Tickets regen

**Session type:** Docs reconciliation (periodic sync pass, per tracker rule 4)
**PR:** #591
**Branch:** `docs/3e-phase1-tracker-update`

### Context

PR #591 was authored 2026-09-09 to record "3E Phase 1 DB merged" and sat open for a week. In
that time the branch went `CONFLICTING` (main added a 3G Superset row, which reflowed the
Phase 3 table) and its content went stale — 3E and 3F both advanced several PR-waves past what
the PR claimed. This pass merges main, resolves the conflict, and rewrites the rows against
verified state rather than preserving the 09-09 snapshot.

### Done

- Merged `origin/main` into the branch and resolved the `roadmap-tracker.md` conflict in favour
  of main's table (keeps the new **3G** row and the corrected 3F migration-range note), then
  re-applied the 3E update on top.
- **3E row rewritten** — 🔴 0% → 🟡 50%. Phase 1 DB (#583, #585, #586; migrations 0092–0100,
  #565 closed) and Phase 2 API routes (#590, #594, merged 2026-09-11) are both in. Phases 3–4
  are in review across #597, #600, #602, #603, #605 — listed as in-review, not as merged.
- **3F row rewritten** — 🔴 0% → 🟡 25%. Phase 1 DB landed via #586 (`schedule_rules`,
  `schedule_executions`, migrations 0101–0103). Phases 2–4 in review: #595, #601, #604.
- **Summary scorecard** — "6 tracks" corrected to 8 (3E/3F/3G had been added without updating
  the count); ~29% → ~38% weighted.
- **Open Tickets by Creator regenerated** from `gh issue list` (tracker rule 5, which had not
  been run in some time): 11 closed issues removed (#490–#498, #192, #19, #15), 12 open ones
  added (3E/3F phase issues #567–#582 and review follow-ups #587–#589, #593). 28 rows, matching
  the live count. Superset issues #102–#106 re-filed from `2D` to `3G` to match main's move.
- **`CLAUDE.md`** 3E/3F rows and the Phase 3 summary line updated — both still read
  "🔴 spec + design complete … Phase 1 starts after ADR accepted", which the merged PRs
  contradict.
- Week-log entry `2026-09-09-3e-phase1-merged.md` normalised to the format its own README
  prescribes (`##` H1 → H2, added the `Session type:` / `PR:` / `Branch:` block).

### Verification

Every row claim was checked against `gh`/`git` rather than carried over: PR merge dates and
commits, issue open/closed state, migration filenames on `main`, and which routes actually
exist under `apps/api/src/routes/`. One drafted detail (PR #583's branch name) was guessed
wrong on the first pass and corrected against `gh pr view` before commit.

### ADR gate — raised, then resolved in-session

The pass opened with ADR-016 and ADR-017 both still `Status: Draft` and nothing in
`docs/decisions/`, while 3E had merged two phases and 3F one — implementation running ahead of
the acceptance gate both tracker rows and `CLAUDE.md` describe. Flagged for a human per
`agent-behaviour.md` ("no phase advance without explicit sign-off") rather than recorded as
routine progress.

Resolved the same day: both ADRs were reviewed and promoted by a human to
`docs/decisions/ADR-016-oncall-routing.md` and `docs/decisions/ADR-017-temporal-scheduler.md`
with `Status: Accepted`, dated 2026-09-16. The drafts under `docs/specs/` were deleted (ADR-016/017
were the first ADRs ever staged there; everything through ADR-015 was written straight into
`docs/decisions/`). Both ADR bodies carried over unchanged apart from dropping the now-redundant
"promote this draft" step. The tracker and `CLAUDE.md` rows record that the phases merged _before_
acceptance — the ADRs ratify shipped behaviour rather than having gated it.

Follow-on fixes from reviewing that promotion: `Status: Acceoted.` typo in ADR-016, a filename that
still read `ADR-017-draft-*`, Prettier failures on both (trailing whitespace — `format:check` covers
`**/*.md`, so this would have failed CI), two design-doc pointers left aimed at the deleted draft
paths, and `CLAUDE.md`'s reference list, which ended at ADR-014 — ADR-015 had never been added
either, so all three went in. The two week-log entries referencing the old draft paths were left
alone: frozen history, accurate as of their dates.

### Next

- Human call on the ADR-016/ADR-017 gate above.
- #567 (3E Phase 2) and #578 (3F Phase 1) are code-complete on main but still open — close them
  after a task-level tick-off, or note what remains.
- #587's pre-Phase-2 verification item is now moot in ordering (Phase 2 merged) — confirm or close.
