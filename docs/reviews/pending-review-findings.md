# Pending Review Findings

**Reconciled:** 2026-08-06 — checked every row below against current `gh issue` state. #162
(tender costing-review automation) closed via PR #343, and #202 (`docker compose down -v`
foot-gun) has since closed; both rows removed per this doc's own rule below. Both ADR-backlog
items ("connector SDK shape", "write the phase-3-primer") are done — ADR-009 (accepted
2026-08-06) covers the connector SDK shape, and `.claude/context/phase-3-primer.md` now exists —
both bullets removed. #199 (`packages/ui` hollow) is also closed — verified directly against
current code (not just PR titles): the design-token layer, the `Table` primitive on all 4
previously-deferred files, and full `useHoverStyle` adoption are all shipped (see
`roadmap-tracker.md`'s #199 row for the PR list); row removed. #161 (non-idempotent seed SQL)
closed via PR #342, which fully implemented the fix with regression tests; row removed. Prior
reconciliation (2026-08-03): #194, #196, #197, and #201 closed
(rows removed); #192 and #198 still open by deliberate scope decision, not neglect; #200 has
scaffolding merged (PR #272) but was still marked "untouched" — corrected. The July-2026
internal security audit (issues #221–#267, tracked in
[roadmap-tracker.md](../sup-docs/roadmap-tracker.md)) is a separate, later audit round and isn't
folded into this doc.

**Consolidated:** 2026-07-24, from a full audit of `docs/reviews/2026-06-29-consulting-review.md`,
`cto-architecture-review.md`, `product-capability-review.md`, and `ux-adoption-review.md` (all
dated 2026-06-23/29). Those four files are now removed — every finding that was already resolved
is left out entirely; this doc keeps **only what's still open**, deduplicated across the four
sources, with a note on whether it already has a tracked GitHub issue.

**Why this exists:** the audit found the security/architecture findings from these reviews mostly
became tracked issues (#120–#129) and got closed. The product/UX findings from the _same reviews,
same date_ mostly never got filed as issues at all, and have sat with zero progress since
2026-06-23 as a direct result. If you pick anything up from this list, file it as an issue first —
that's the difference between the two halves of this list.

---

## Already has a tracked issue — just needs a person

**Reconciled 2026-08-19:** #143 (automation-triggered transitions absent from outbox) closed —
both phases done per `docs/sup-docs/week-log.md`'s 2026-08-12 entries (PR #372, #380); row
removed per this doc's own rule below.

| Finding                                                                                                                                                                                                                               | Issue                    | Owner      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- |
| No backup / disaster-recovery runbook — mechanical building block shipped (PR #286), RPO/RTO policy still an open maintainer decision                                                                                                 | [#192](../../issues/192) | Unassigned |
| No accessibility floor on modals — waves 1 & 2 shipped (PR #285, PR #298); 2 items deliberately deferred (workflow-canvas slide-in panel, access-denied overlay); closing vs. leaving open for those 2 is an open maintainer decision | [#198](../../issues/198) | Unassigned |
| Zero internationalization — scaffolding shipped (PR #272), ~55 of 57 files still hardcoded English                                                                                                                                    | [#200](../../issues/200) | Unassigned |

---

## No tracked issue yet — file before picking up

### ADR backlog (all from the 2026-06-29 consulting review, still open)

ADRs are human-authored per `CLAUDE.md` convention — these are intentionally **not**
filed as GitHub issues; they're tracked here and via `CLAUDE.md`'s Phase 3 table instead.

- ADR-002 addendum for a design gap surfaced during the consulting review (see the review itself
  in git history for detail if picked up — not re-summarized here)
- MT-02/WE-05 triage items (see git history for the original review for detail)
- ADRs still needed for: AI layer (3C), observability (3D)

---

## How to use this doc

1. Before starting anything above, run `gh issue list --state all --search "<keyword>"` to
   double check it hasn't been filed/closed since 2026-08-03.
2. File a GitHub issue before implementing — that's the exact gap that let the UX findings sit
   untouched for a month while the security findings from the same review session got fixed.
   (As of 2026-07-24, every non-ADR finding here now has one — see the table above.)
3. When something here is closed, delete its row (don't mark it done in place) — this doc's
   entire value is being _only_ the pending list, not a history. `week-log.md` is where closures
   get logged.
