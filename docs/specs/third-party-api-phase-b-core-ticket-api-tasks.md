# Implementation Plan: Third-Party API — Phase B: Core Ticket API

**Spec:** `docs/specs/third-party-api-phase-b-core-ticket-api.md`
**Generated:** 2026-08-22
**Status:** ✅ Done — all 4 phases closed 2026-08-23. PR B1 #461, B2 #464, B4 #465, B3 #466 all
merged (approved by PrabhuVijit). R10 (T4d) deliberately deferred to a fast-follow PR — see its
row below.

**Branch note:** per `SESSION-CONTEXT.md` §5, Phase B's first feature branch is created off
`test/phase-a-r1-r3-r9-closeout` (which stacks on `docs/phase-a-closeout`, both currently
local-only) — not off `main` directly — so Phase A's two pending closeout commits ride along
with Phase B's first PR instead of getting their own standalone PR.

---

## Phase 1 — Dual-identity auth middleware (PR B1)

**Goal:** every request to any future ticket endpoint carries and verifies both identities
before any endpoint-specific logic runs.
**Gate:** all unit tests pass → then Phase 2

| task                                                                                                                                                                                                      | requirement      | status         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------- |
| T1a: Tier-1 person-token verification (signature/issuer/expiry), reusing the same rigor as human login                                                                                                    | R1               | done — PR #461 |
| T1b: `aud` claim check against the presented key's stored `zitadel_client_id`, both string and array forms                                                                                                | R2               | done — PR #461 |
| T1c: `iat` freshness check, 15-min config-driven max age, independent of Zitadel's own expiry                                                                                                             | R3               | done — PR #461 |
| T1d: tenant/org-match gate as its own distinct check (not inferred from token validity)                                                                                                                   | R4               | done — PR #461 |
| T1e: generic unauthorized response for every auth-layer failure (bad key, bad/malformed/missing person token, `aud` mismatch, stale `iat`, tenant mismatch) — no distinguishing detail across any of them | R14 (auth cases) | done — PR #461 |

---

## Phase 2 — Read endpoints (PR B2, PR B4)

**Goal:** a third party can discover which workflow to create into and fetch a ticket it has
access to.
**Gate:** integration + isolation tests pass + Phase 1 gate still green

| task                                                                                                                   | requirement | status                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| T2a: `GET /api/v1/workflows` — access-list-filtered, returns `id`/`name`/entity-type only                              | R5, R8      | done — PR #464                                                                                     |
| T2b: pagination on list-workflows, deterministic explicit ordering                                                     | R5          | done — PR #464                                                                                     |
| T3a: `GET /api/v1/tickets/:id` — access-list gated via existing `hasEntityAccess`/`assertRecordWorkflowAccess` helpers | R7, R8      | done — PR #465                                                                                     |
| T3b: always-404 on denial, including the cross-tenant-guess case (RLS-only, no separate code path)                     | R7          | done — PR #465 (byte-identical body for not-found vs. denied, closing the ticket-existence oracle) |

---

## Phase 3 — Ticket creation (PR B3)

**Goal:** a third party can create a ticket attributed to a real person + application, always
into the workflow's initial state.
**Gate:** integration + isolation tests pass + Phases 1–2 gates still green

| task                                                                                                                                            | requirement        | status                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T4a: `POST /api/v1/tickets` — silently forces initial state regardless of any `state` field sent, no rejection path for this case               | R6                 | done — PR #466                                                                                                                                                                                                                                               |
| T4b: scope enforcement (key scopes ∩ person RBAC ∩ tenant RLS), `entity:ticket:create` required                                                 | R8                 | done — PR #466                                                                                                                                                                                                                                               |
| T4c: dual-identity actor/creator correctness on the created record + `admin_audit_log` (`actor_type='api_key'` + populated acting-person field) | R9                 | done — PR #466 (new nullable `acting_person_id` column, migration `0073_admin_audit_log_acting_person.sql` — renumbered from 0072 during rebase; also fixed a latent bug where `createEntity`'s audit hook hardcoded `actorType: "user"`)                    |
| T4d: "Agent" list-page tag + "Auto-generated by [Application Name]" detail-page banner (admin-ui)                                               | R10                | **deferred — fast-follow PR** (confirmed with human 2026-08-22): application name isn't cheaply available at ticket-read time (lives on `api_keys`, only joinable via the audit log's create entry) — separable UI+query concern from B3's core create logic |
| T4e: ingress-level rejection of null bytes/control chars/non-UTF-8 in any string field                                                          | R11                | done — PR #466 (`validate-fields-payload.ts`)                                                                                                                                                                                                                |
| T4f: render-time sanitization audit for API-submitted field values/filenames (no unsafe-HTML paths)                                             | R12                | done — PR #466                                                                                                                                                                                                                                               |
| T4g: payload size/depth guard on `fields`, ahead of entity-engine validation                                                                    | R13                | done — PR #466 (100KB size cap, depth cap 8)                                                                                                                                                                                                                 |
| T4h: specific, clear validation errors for bad field/type on create; plain 5xx with no detail leak on server failure                            | R14 (create cases) | done — PR #466                                                                                                                                                                                                                                               |

---

## Phase 4 — Verification & close-out

**Goal:** confirm the phase is actually done, not just merged.
**Gate:** §R acceptance criteria met, `/security-review` clean

| task                                                                                                                              | requirement | status                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T5: `/security-review` (mandatory — new write + read surface), `/review`, docs marker, commit procedure, PR(s) per B1–B4 chunking | all         | done — all 4 PRs reviewed + merged                                                                                                                                                                                                                                                                     |
| T6: re-run Phase 0's harness against these 3 endpoints                                                                            | all         | done — real end-to-end run via a new local reference client, `OWTester` (`C:\Users\User\Desktop\Tushar\OFF\OWTester`), exercising a genuine Zitadel PKCE login + all 3 endpoints against the running API; full golden path (list workflows → create ticket → fetch it back) confirmed green 2026-08-23 |

---

## Kick-Off Prompt

```
Read docs/specs/third-party-api-phase-b-core-ticket-api.md and
docs/specs/third-party-api-phase-b-core-ticket-api-tasks.md.

Implement Phase 1 tasks only (T1a-T1e) — the dual-identity auth middleware, PR B1.

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B (on the Phase B spec) to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
- Branch off test/phase-a-r1-r3-r9-closeout, not main directly
```

---

_After each phase: if any tests failed, run `/spec amend §B`. If a pattern emerged that
shouldn't repeat, run `/spec amend §V`._
