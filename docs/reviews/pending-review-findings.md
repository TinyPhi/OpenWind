# Pending Review Findings

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

| Finding                                                                            | Issue                    | Owner          |
| ---------------------------------------------------------------------------------- | ------------------------ | -------------- |
| `notify` action is a stub, Novu never wired up                                     | [#125](../../issues/125) | Bikash Barnwal |
| Automation-triggered transitions absent from outbox (Phase 3A connector gap)       | [#143](../../issues/143) | Bikash Barnwal |
| 6 of 7 standard modules ship no automations, non-idempotent seed SQL               | [#161](../../issues/161) | Tushar Sharma  |
| Tender costing-review automation references nonexistent `create_child` action      | [#162](../../issues/162) | Tushar Sharma  |
| `assign`/`create_entity` automation action types declared but never dispatched     | [#191](../../issues/191) | Unassigned     |
| No backup / disaster-recovery runbook                                              | [#192](../../issues/192) | Unassigned     |
| Every non-core Docker image pinned to `:latest`                                    | [#193](../../issues/193) | Unassigned     |
| `tests/e2e/` has no actual test harness                                            | [#194](../../issues/194) | Unassigned     |
| Rate limiter buckets on an unverified JWT claim, not the authenticated tenant      | [#195](../../issues/195) | Unassigned     |
| Scale-risk backlog: cache invalidation, search pagination, N+1, pool ceiling       | [#196](../../issues/196) | Unassigned     |
| Several field types render as plain text inputs in the portal (#1 adoption-killer) | [#197](../../issues/197) | Unassigned     |
| No accessibility floor on modals                                                   | [#198](../../issues/198) | Unassigned     |
| `packages/ui` is hollow — no real shared component library                         | [#199](../../issues/199) | Unassigned     |
| Zero internationalization                                                          | [#200](../../issues/200) | Unassigned     |
| Native `confirm()`/`alert()` used instead of a shared dialog                       | [#201](../../issues/201) | Unassigned     |
| `docker compose down` vs `-v` data-loss foot-gun                                   | [#202](../../issues/202) | Unassigned     |

---

## No tracked issue yet — file before picking up

### ADR backlog (all from the 2026-06-29 consulting review, still open)

ADRs are human-authored per `CLAUDE.md` convention — these are intentionally **not**
filed as GitHub issues; they're tracked here and via `CLAUDE.md`'s Phase 3 table instead.

- ADR for the connector SDK shape (blocks 3A)
- Write `.claude/context/phase-3-primer.md` before 3A starts (required per `CLAUDE.md`'s Current
  Focus section)
- ADR-002 addendum for a design gap surfaced during the consulting review (see the review itself
  in git history for detail if picked up — not re-summarized here)
- MT-02/WE-05 triage items (see git history for the original review for detail)
- ADRs still needed for: plugin system (3B), AI layer (3C), observability (3D), **rate-limiting
  strategy** (blocks a principled fix for [#195](../../issues/195)), notification SLA policy

---

## How to use this doc

1. Before starting anything above, run `gh issue list --state all --search "<keyword>"` to
   double check it hasn't been filed/closed since 2026-07-24.
2. File a GitHub issue before implementing — that's the exact gap that let the UX findings sit
   untouched for a month while the security findings from the same review session got fixed.
   (As of 2026-07-24, every non-ADR finding here now has one — see the table above.)
3. When something here is closed, delete its row (don't mark it done in place) — this doc's
   entire value is being _only_ the pending list, not a history. `week-log.md` is where closures
   get logged.
