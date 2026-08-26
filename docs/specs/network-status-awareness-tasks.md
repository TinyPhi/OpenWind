# Implementation Plan: Network Status Awareness

**Spec:** docs/specs/network-status-awareness.md
**Generated:** 2026-08-25
**Status:** not started

---

## Phase 1 — Core store + the independent bug fix

**Goal:** the network-status store exists and correctly derives state from probe/browser/socket inputs; the unrelated `doFetch()` transport-failure bug is fixed.
**Gate:** all unit tests pass → then Phase 2

| task                                                                         | requirement | status |
| ---------------------------------------------------------------------------- | ----------- | ------ |
| T1: `notifications-client.ts` — add `subscribeToConnectionState`             | R2          | todo   |
| T2: `network-status.ts` — store, probe, backoff, visibility/BFCache handling | R2, R3, R5  | todo   |
| T3: `api.ts` — fix `doFetch()`'s catch to dispatch on transport failure      | R4          | todo   |

---

## Phase 2 — Banner integration, i18n, tests

**Goal:** the banner shows the three network states correctly, accessibly, and in the same i18n pass; behavior is covered by tests.
**Gate:** §R acceptance criteria met — Phase 1 gate still green

| task                                                                                                           | requirement | status |
| -------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4: `global-error-banner.tsx` — `"offline"` kind, three-state copy, a11y attributes, full-file i18n conversion | R1, R6      | todo   |
| T5: tests — `network-status.test.ts` (new) + `global-error-banner.test.tsx` (new)                              | R1-R6       | todo   |

---

## Kick-Off Prompt

Read docs/specs/network-status-awareness.md and docs/specs/network-status-awareness-tasks.md.

Implement both phases in one pass (small diff, ~5 files, tightly coupled — Phase 2 can't be
meaningfully tested without Phase 1 existing).

Rules:

- Tests land in the same pass as the code they cover (project-wide rule, not spec-specific).
- If a decision isn't covered by the spec, stop and ask — do not assume.
- If something fails, log it via `/spec amend §B` before fixing.
- If a bug class could recur, promote it to `/spec amend §V`.
