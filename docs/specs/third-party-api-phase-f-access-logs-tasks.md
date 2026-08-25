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
| T1: Outcome-classification module — centralized action-name → `"allowed" \| "denied"` map covering every current `AuditAction` (base + `tag.*` + `attachment.*` + `transition.*`)                                                                                | R1          | todo   |
| T2: Admin route `GET /api/admin/third-party-access-logs` — tenant-scoped wrapper over `queryAuditLog`, resolves `applicationName` from `api_keys`, applies T1's classification, adds an additive `outcome` filter to `@platform/audit`                           | R1, R2      | todo   |
| T3: Admin-ui screen — filterable table (application/person/ticket/date-range/outcome) on the existing Refine/shadcn conventions; renders an anonymized/placeholder row without erroring; shows the R5 residual-risk caveat inline near the misuse-alerts section | R2, R5, R6  | todo   |
| T4: End-to-end isolation test — for each of comment-post/sub-ticket-create/attachment-reference/transition, a denied attempt produces zero `workflow_events` rows and exactly one `admin_audit_log` row, verified together (not per-phase)                       | R3          | todo   |

---

## Phase 2 — Misuse-alert triggers + hardening

**Goal:** Three baseline misuse conditions notify admins proactively, each independently
testable and each correctly deduplicated per its own episode semantics.
**Gate:** §R acceptance criteria met, `/security-review` clean, Phase 1 gate still green → PR opens

| task                                                                                                                                                                                                                                               | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: Trigger 1 (10 auth failures / 5-min rolling window per key) + trigger 2 (volume > 5× trailing-7-day hourly average, 24h min baseline) — Redis-backed counters feeding `@platform/notifications`                                                | R4          | todo   |
| T6: Trigger 3 — wire the existing `tag.misuse_rate_capped` audit write to the same notification path as T5 (naturally one-shot, no extra dedup logic needed)                                                                                       | R4          | todo   |
| T7: Screen-level residual-risk disclosure wiring for trigger 2 (confirms T3's caveat renders against the real trigger-2 implementation, not a stub)                                                                                                | R5          | todo   |
| T8: Isolation tests for all 3 triggers (fires under threshold-breach, dedup within an episode, silent under normal usage) + `/security-review` (tenant isolation, admin-only auth boundary, redaction-not-reversed) + `/review` + docs marker + PR | R4          | todo   |

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
