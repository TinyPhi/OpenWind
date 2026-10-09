# 2026-10-09 — ADR-004 / ADR-006 stale wording (#768, #703)

**Session type:** Docs, human-requested ADR edit
**Branch:** `docs/PLAT-768-adr-004-006-stale-wording`

- ADR-004 decision 3's example rule used `trigger = workflow.entered_state` with a `state`
  condition. That trigger type was retired in #763 (nothing emits it; the wizard saves it as
  `workflow.transitioned` scoped by `toState`, `payload.ts`). The example now reads
  `workflow.transitioned` scoped to `toState = "escalated"`. #768 names `field.changed` as the
  stale example, but ADR-004 contains no such string; `workflow.entered_state` was the retired
  type it actually used.
- ADR-006's Context paragraph and Decision item 5 described `grant-access.ts` as admin/agent
  only. Both now say the gap was resolved by PR #179 (`requireRole("admin", "agent", "user")` plus
  an `isWorkflowAdmin` check). The WA-06 row's "left as written" note is updated to match.
- ADRs are normally human-written. The owner asked for these edits in-session.
