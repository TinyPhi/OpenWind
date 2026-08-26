# Implementation Plan: Third-Party API Phase G — Hardening

**Spec:** docs/specs/third-party-api-phase-g-hardening.md
**Generated:** 2026-08-26
**Status:** not started

---

## Phase 1 — Rate limiting, token freshness, PII redaction, TLS verification

**Goal:** Every request-time hardening check that doesn't require a new persistent cache
(rate limiting, `iat` freshness, redaction, TLS) is in place and independently testable.
**Gate:** all unit + isolation tests pass, typecheck/lint clean → then Phase 2

| task                                                                                                                                                                     | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T1: Wire ADR-013's 3-tier rate limiting (per key+person 20/min, per key aggregate 200/min, per tenant configurable) into third-party routes, reusing `checkRateLimit`    | R1          | todo   |
| T2: Per-tenant admin-editable rate-limit ceiling (new column/table + admin PATCH route only — no new admin-ui screen this phase; reuse existing admin route conventions) | R2          | todo   |
| T3: JWT `iat` max-age check (config-driven, default 15min, startup sanity warning); confirm interaction with the existing `clockTolerance: 5` at the 15-min boundary     | R6          | todo   |
| T4: PII redaction wired into third-party ticket-detail and workflow-list read routes, reusing `redactMetadata`/`buildSensitivityMap`                                     | R7          | todo   |
| T5: TLS/HTTPS enforcement point — verify infra-level enforcement OR add an app-level check; document which in §B                                                         | R11         | todo   |

---

## Phase 2 — Idempotency

**Goal:** Create/comment/sub-ticket/transition are all safe to retry, scoped correctly, with
no duplicate-execution window.
**Gate:** all unit + isolation tests pass, Phase 1 gate still green → then Phase 3

| task                                                                                                                                                                               | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T6: Idempotency schema (`idempotency_keys` table), RFC 8785 canonicalization + content-hash helper                                                                                 | R3, R4      | todo   |
| T7: 30s in-flight lock (409 + Retry-After) + 24h result-cache read/write, wired into create/comment/sub-ticket/transition routes; lock and cache share the identical 3-tuple scope | R3, R4, R5  | todo   |

---

## Phase 3 — Retention, purge, and closing gate

**Goal:** Access-log data has a bounded lifetime, a tenant purge is complete (audit log +
idempotency cache), Phase F's residual risk is confirmed documented, and the whole third-party
API feature set passes a final security review.
**Gate:** §R acceptance criteria met, `/security-review` clean → PR(s) open

| task                                                                                                                             | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T8: Access-log retention: scheduled 90-day sweep job + aggregate rollup table                                                    | R8          | todo   |
| T9: Tenant-purge: replace "retain forever" with immediate anonymization of that tenant's `admin_audit_log` rows                  | R9          | todo   |
| T10: Tenant-purge: extend the same purge path to delete that tenant's `idempotency_keys` rows outright                           | R10         | todo   |
| T11: Confirm Phase F's residual-risk disclosure is still accurate/visible (verification only, code change only if found missing) | R12         | todo   |
| T12: Full end-to-end `/security-review` across Phases A–G + isolation tests for every new table/route + PR                       | R13         | todo   |

phase gate: all unit + isolation tests pass, `/security-review` clean, before each stage's PR opens

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-api-phase-g-hardening.md and
docs/specs/third-party-api-phase-g-hardening-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4, T5).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
