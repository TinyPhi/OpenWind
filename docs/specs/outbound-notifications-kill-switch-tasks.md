# Implementation Plan: Global Outbound-Notifications Kill Switch

**Spec:** docs/specs/outbound-notifications-kill-switch.md
**Generated:** 2026-07-25
**Status:** not started

---

## Phase 1 — Data Model

**Goal:** New single-row global settings table exists, migrated, with a typed read helper.
**Gate:** `pnpm typecheck` clean, migration applies cleanly, unit test for the read helper
(including fail-closed-on-error path) passes.

| task                                                                                         | requirement | status |
| -------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Add `platformSettings` table to `packages/db/src/schema/platform.ts`                     | R1, R8      | todo   |
| T2: New Drizzle migration (`00XX_platform_settings.sql`) incl. seed row `id=1`               | R1          | todo   |
| T3: `isOutboundNotificationsEnabled()` helper (fail-closed on error/missing row) + unit test | R5          | todo   |

---

## Phase 2 — API Layer

**Goal:** Admin-role-gated read/write route for the flag.
**Gate:** route tests pass (200 for admin, 403/404 for non-admin per security.md's
"404 not 403 for cross-tenant" doesn't apply here since it's not tenant-scoped — but
non-admin must still be rejected), Phase 1 gate still green.

| task                                                                                                                                                                               | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4: `GET /admin/platform-settings` route (admin-role-gated, Zod response)                                                                                                          | R3          | todo   |
| T5: `PATCH /admin/platform-settings` route (admin-role-gated, Zod body validation)                                                                                                 | R2          | todo   |
| T6: Wire the fail-closed check into both enqueue call sites (`notify.ts`, `notification-worker.ts:142`) + tests confirming in-app delivery still happens when outbound is disabled | R4, R5, R7  | todo   |

---

## Phase 3 — Consumer Integration (Admin UI)

**Goal:** Toggle visible and functional on the settings page for admins.
**Gate:** §R acceptance criteria met; manual verification (toggle off → trigger a
notification → confirm in-app notification still arrives, no `notify-outbound` job
enqueued; toggle back on → confirm outbound enqueue resumes).

| task                                                                                                                                                   | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T7: Add toggle to `apps/admin-ui/src/pages/settings.tsx` (admin-only, optimistic update + revert-on-failure, same pattern as module-visibility toggle) | R6          | todo   |
| T8: End-to-end manual verification per Gate above, update `docs/sup-docs/week-log.md`                                                                  | R1-R8       | todo   |

---

## Acceptance Criteria (for plan-lock)

| id  | text                                                                                    | verify                                                                |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| AC1 | `platform_settings` table exists with a single seeded row, default `true`               | `pnpm db:migrate && pnpm test -t platform-settings`                   |
| AC2 | Read helper fails closed (returns `false`) on DB error or missing row                   | `pnpm test -t isOutboundNotificationsEnabled`                         |
| AC3 | `GET`/`PATCH /admin/platform-settings` are admin-role-gated and validated               | `pnpm test -t platform-settings-route`                                |
| AC4 | Both outbound enqueue call sites skip enqueue when disabled; in-app delivery unaffected | `pnpm test -t notify-outbound-toggle`                                 |
| AC5 | Admin-ui settings page renders and persists the toggle                                  | manual verification (browser) — no automated UI test in this repo yet |

---

## Kick-Off Prompt

```
Read docs/specs/outbound-notifications-kill-switch.md and
docs/specs/outbound-notifications-kill-switch-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
```
