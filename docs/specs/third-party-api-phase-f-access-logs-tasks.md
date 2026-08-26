# Implementation Plan: Third-Party API Phase F — API Access Logs Screen

**Spec:** docs/specs/third-party-api-phase-f-access-logs.md
**Generated:** 2026-08-25
**Status:** not started

---

## Phase 1 — Read path: classification, admin route, screen, cross-phase verification

**Goal:** An admin can view, filter, and trust the existing B–E audit trail on a dedicated
screen, with denied attempts provably absent from ticket timelines across every action type.
**Gate:** all unit + isolation tests pass, typecheck/lint clean → then Phase 2

| task                                                                                                                                                                                                                                                             | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Outcome-classification module — centralized action-name → `"allowed" \| "denied"` map covering every current `AuditAction` (base + `tag.*` + `attachment.*` + `transition.*`)                                                                                | R1          | done   |
| T2: Admin route `GET /admin/third-party-access-logs` — tenant-scoped wrapper over `queryAuditLog`, resolves `applicationName` from `api_keys`, applies T1's classification, adds an additive `outcome`/`actingPersonId` filter to `@platform/audit`              | R1, R2      | done   |
| T3: Admin-ui screen — filterable table (application/person/ticket/date-range/outcome) on the existing Refine/shadcn conventions; renders an anonymized/placeholder row without erroring; shows the R5 residual-risk caveat inline near the misuse-alerts section | R2, R5, R6  | done   |
| T4: End-to-end isolation test — for each of comment-post/sub-ticket-create/attachment-reference/transition, a denied attempt produces zero `workflow_events` rows and exactly one `admin_audit_log` row, verified together (not per-phase)                       | R3          | done   |
| T1b (scope-expanded, AC4/AC6): retrofit comments.ts/children.ts/attachments-reference.ts to write admin_audit_log atomically (previously unaudited); fix actorId across all 4 routes (incl. transitions.ts) to record the API key id, not actingPersonId         | AC4, AC6    | done   |

---

## Phase 2 — Misuse-alert triggers + hardening

**Goal:** Three baseline misuse conditions notify admins proactively, each independently
testable and each correctly deduplicated per its own episode semantics.
**Gate:** §R acceptance criteria met, `/security-review` clean, Phase 1 gate still green → PR opens

| task                                                                                                                                                                                                                                                                                                                                                                                                                     | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T5: Trigger 1 (10 auth failures / 5-min fixed window per key, wired via requireTicketScope's 403 branch) + trigger 2 (volume > 5× trailing-7-day hourly average, 24h min baseline) — Redis-backed counters in `apps/api/src/lib/misuse-alerts.ts`, firing through a new `@platform/notifications#fireMisuseAlert` (a `system.error` outbox event — reuses ADR-014's existing admin-alert channel, no new delivery infra) | R4          | done   |
| T6: Trigger 3 — wire the existing `tag.misuse_rate_capped` audit write (`apps/worker/src/mention-resolution-worker.ts`) to the same `fireMisuseAlert` channel as T5 (naturally one-shot, no extra dedup logic needed)                                                                                                                                                                                                    | R4          | done   |
| T7: Screen-level residual-risk disclosure wiring for trigger 2 — already satisfied by T3's caveat text (Phase 1), which doesn't depend on trigger 2's internals, only its threshold-based nature (unchanged)                                                                                                                                                                                                             | R5          | done   |
| T8: Isolation tests for triggers 1+2 (fires under threshold-breach, dedup within an episode, silent under normal usage) via real Redis + real routes; trigger 3 covered by its existing unit test (fires from an already-isolation-tested worker path) + `/security-review` + `/review` + docs marker + PR                                                                                                               | R4          | done   |

phase gate: all unit + isolation tests pass, `/security-review` clean, before PR opens

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-api-phase-f-access-logs.md and
docs/specs/third-party-api-phase-f-access-logs-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
