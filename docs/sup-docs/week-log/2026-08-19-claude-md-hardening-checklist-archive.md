## 2026-08-19 — CLAUDE.md cleanup: archive of two fully-resolved "Current focus" blocks

**Session type:** docs cleanup (housekeeping, not a feature track)

Both blocks below were removed verbatim from `CLAUDE.md`'s "Current focus" section during a
review of that file's relevance now that every item in them is closed. `CLAUDE.md` is loaded
automatically every session, so content that no longer reflects _current_ focus — fully resolved
checklists, fully reconciled open questions — is pure token cost for sessions that never touch
it. Nothing here is new information; this is the same text CLAUDE.md carried, moved rather than
summarized, per this project's own "no silent removal" convention. CLAUDE.md now carries a
one-line pointer to this file instead.

---

### Block 1: "Pre-Phase 3 hardening (external review flagged)" — as it read pre-archive

**Pre-Phase 3 hardening (external review flagged) — status as of 2026-07-24:**

These were correctness/safety fixes in existing code, not Phase 3 features. **Only #125 remains
open** — see [docs/reviews/pending-review-findings.md](../../reviews/pending-review-findings.md)
for it and every other still-open finding from the original review round (the four dated review
docs this consolidates were removed 2026-07-24; their resolved findings aren't repeated here).

- [x] #121 RLS under real role (`SET LOCAL ROLE app_user`) — PR #135
- [x] #122 Isolation tests run as `app_user`, not superuser — alongside #121
- [x] #126 `entity.created`/`entity.assigned` triggers never fired — PR #138
- [x] #127 `setEntityState`/`bulkSetState` unguarded state side-door — PR #155. Follow-up gap
      it surfaced (no `workflow_states` validation) was filed as #160 and closed via PR #180
      (2026-07-24).
- [x] #120 Automation double-trigger (depth resets on outbox path) — PR #139
- [x] #123 Automation queue had no retries — `2369723`
- [x] #124 Auth middleware wrote on every request — `2c44411`
- [x] #128 OpenBao + MinIO commented out of `docker-compose.yml` — PR #173 (2026-07-23),
      idempotency follow-up PR #188 (2026-07-24)
- [x] #129 Worker has no health endpoint — PR #175 (2026-07-24)
- [x] #141 `pnpm lint` was a repo-wide no-op — PR #166
- [x] #136 RLS for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions` — ADR-007
      accepted 2026-07-24; implementation in PR #181 (open, awaiting review)
- [x] **#125** `notify` action wired end-to-end — outbox-pattern delivery worker, in-app inbox,
      WebSocket live push, pluggable outbound seam — PR #211 (2026-07-29).

See [docs/sup-docs/roadmap-tracker.md](../roadmap-tracker.md) for the fuller,
actively-maintained backlog table (includes #143, #160–#171 follow-ons, and PR-in-review status).

**Note as of 2026-08-19 (archival time):** by the time this was archived, #125 (the item marked
"only open") was itself already checked off in the list directly below it — CLAUDE.md had drifted
into self-contradiction the same way the 2D no-code-builder tracker row once had (fixed in commit
`332e1b3`). #143 (referenced above as a "follow-on" in the roadmap-tracker pointer) is also closed
(verified via `gh issue view 143` at archival time — Automation-triggered transitions absent from
outbox, closed via the Stage 0 work logged in this same week-log directory's 2026-08-12 entries).
Also caught on a later re-check (2026-08-19, after being challenged on it): Block 1's #128 row
above says "idempotency follow-up PR #188" — that's wrong, inherited from the pre-archive
CLAUDE.md text rather than introduced here. `gh pr view 178` confirms PR #178
("fix(dx): make openbao-init idempotent across compose restarts", merged 2026-07-24) is the
actual idempotency follow-up; PR #188 is an unrelated bundle of 5 nit-fixes merged 2026-07-25
(`docs/sup-docs/roadmap-tracker.md`'s own Pre-Phase-3 hardening table already had #178 right —
only this file's verbatim-archived block had the wrong number). Left the verbatim text above
unchanged rather than silently edit "history" — this note is the correction.

### Block 2: "Shipped 2026-07-16 to 2026-07-21 — now formally ratified" — as it read pre-archive

**Shipped 2026-07-16 to 2026-07-21 — now formally ratified.** PR #144 (2026-07-16 — child
tickets, the `modules/tender` vertical, an access-request/grant authorization layer) and PRs
#151/#152/#155 (2026-07-21 — Zitadel org-id→tenant mapping, a request-access UI, the
per-workflow ownership/admin model) landed outside the `openwind-loop` process and sat
unclassified until 2026-07-22's reconciliation flagged two open questions. Both are now
resolved:

1. **Per-workflow ownership/admin model → ADR-006** (accepted 2026-07-24). Permanent, accepted
   policy. Its own noted gap — transition guards not consulting per-instance `__accessUsers`
   grants — remains an accepted v1 limitation, not yet its own issue.
2. **`tender` module scope → ADR-005** (accepted 2026-07-23). `tender` is the platform's 8th
   module, classified `optional` (the `modules.category` column and auto-provisioning shipped
   via PR #342, 2026-08-06, closing #165).

---

### Mapping table

| Content                                                     | Was in CLAUDE.md        | Now lives                                                                                  |
| ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| Pre-Phase 3 hardening checklist (#120–#129, #136, #141)     | "Current focus" section | This file (Block 1, verbatim) — permanent facts are in the closed GH issues/PRs themselves |
| "Shipped 2026-07-16 to 2026-07-21" reconciliation narrative | "Current focus" section | This file (Block 2, verbatim) — permanent decisions are in ADR-005 / ADR-006               |
