# Implementation Plan: GDPR Erasure Coverage (#635)

**Spec:** docs/specs/gdpr-erasure-coverage.md
**Generated:** 2026-09-27
**Status:** implemented

---

## Phase 1 — Tenant purge

**Goal:** a purge completes for a fully populated tenant and leaves nothing behind.
**Gate:** T1 passes (after failing first) + existing tenant-purge isolation tests green.

| task                                                                                | requirement | status |
| ----------------------------------------------------------------------------------- | ----------- | ------ |
| T1: prove-it purge isolation test (every tenant table seeded)                       | R1, R2, V3  | done   |
| T2: migration — GRANT DELETE on ticket_alerts, access_requests to app_user          | R3          | done   |
| T3: tenant-purge.ts — privileged pre-step, FK-safe order, 14 tables, exported lists | R1, R2      | done   |

---

## Phase 2 — Per-user erasure

**Goal:** `DELETE /users/:userId` succeeds and scrubs every user reference.
**Gate:** T4 passes (after failing first) + Phase 1 gate green.

| task                                                                                 | requirement | status |
| ------------------------------------------------------------------------------------ | ----------- | ------ |
| T4: prove-it erasure isolation test calling the real handler                         | R3, R4, V3  | done   |
| T5: users.ts — saved_views via target app.user_id, 15 missing columns, on-call rules | R3, R4      | done   |

---

## Phase 3 — Drift guard + docs

**Goal:** new tables/columns can't silently escape either erasure path.
**Gate:** full exit condition (typecheck, lint, test, test:isolation) + /security-review.

| task                                               | requirement | status |
| -------------------------------------------------- | ----------- | ------ |
| T6: coverage guard test against information_schema | R5          | done   |
| T7: db-conventions.md rule, tracker, week-log      | R6          | done   |
