# Implementation Plan: Third-Party API Key — External-IdP Org Mapping

**Spec:** docs/specs/third-party-key-external-org-mapping.md
**Generated:** 2026-08-31
**Status:** complete

---

## Phase 1 — Multi-Issuer Verification Infra

**Goal:** `packages/auth` can verify a token against ANY configured issuer's JWKS and read that
issuer's own org-claim name — not just Zitadel's. No consumer wired up yet; this phase is pure
infra with its own tests, nothing user-visible changes.
**Gate:** all unit tests pass → then Phase 2

| task | task                                                                                                                                                                                                                                                                    | requirement | status |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1   | Resolved by spec-review: `externalIssuer` is always explicit admin input on `POST /api-keys`, never derived via a live discovery-document fetch at creation time (see spec §I)                                                                                          | R2, R4      | done   |
| T2   | Generalize `packages/auth/src/jwks.ts` to resolve JWKS per-issuer (cache multiple `JwksGetter`s keyed by issuer), not one static global source. Reconcile with `nexus-OW`'s existing local fork implementation, reviewed against `security.md` rather than ported as-is | R3          | done   |
| T3   | Generalize `dual-identity.ts`'s org-claim read to resolve the claim NAME per-issuer (Zitadel: `urn:zitadel:iam:user:resourceowner:id`; AuthNexus: `org_id`) instead of hardcoding Zitadel's. Same `security.md` review caveat as T2                                     | R3          | done   |
| T3a  | Unit tests: T2's per-issuer JWKS cache resolves the correct key set for 2+ distinct issuers, doesn't cross-contaminate; T3's claim-name resolution reads the right claim per issuer                                                                                     | R3          | done   |

---

## Phase 2 — Schema, Validation, and Verification Wiring

**Goal:** an admin can create a third-party key that trusts a specific external IdP org, the
system enforces the mapping is present when actually needed, and request-time verification uses
it correctly.
**Gate:** all isolation tests pass + Phase 1 gate still green → §R acceptance criteria met

| task | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | requirement | status |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4   | Migration: `external_issuer` (text, nullable), `external_org_id` (text, nullable) on `api_keys`. Analytics annotation + RLS unaffected (no new tenant-scoped table, existing `api_keys` RLS applies)                                                                                                                                                                                                                                                                                                                                                                                                                             | R1, R3      | done   |
| T5   | `createApiKeyHandler`: extend `CreateApiKeySchema` with `externalIssuer`/`externalOrgId`; implement the 4-way validation from spec §I (omitted+omitted OK, issuer-equals-primary rejected, issuer-differs+orgId-omitted → `422 ORG_MAPPING_REQUIRED`, both-supplied+differs → stored). Per §B B5 (post-implementation security review): primary-IdP-match now compares normalized `URL.origin` instead of a trailing-slash-only string comparison, and a valid `externalIssuer` is additionally run through the new `packages/auth/src/ssrf-guard.ts` before being accepted (`422` if it resolves to a private/reserved address) | R1, R2, R4  | done   |
| T6   | `dual-identity.ts`: when the presented key has `external_issuer`/`external_org_id` set, verify against those (using T2/T3's per-issuer resolution) instead of `tenants.zitadel_org_id`; unset → today's path, byte-for-byte. Per §B B3, also added: an LRU-ish bound on `jwks.ts`'s `_jwksByIssuer` cache (`MAX_CACHED_EXTERNAL_ISSUERS = 50`, evicts least-recently-used on overflow), with the 1-hour `cacheMaxAge` deliberately kept as a shared constant rather than made per-issuer-configurable (documented rationale in `jwks.ts`)                                                                                        | R3, R5      | done   |
| T7   | Isolation tests: R1 (single-IdP key unaffected), R2 (missing mapping rejected at creation, no row written), R3 (valid mapping stored + used at verification), R4 (redundant mapping rejected), R5 (`tenant-org-id-mapping.md` suite untouched — not re-run in this PR's scope, no change made to that code path). Real Postgres, no mocks except the issuer-specific `verifyJwtForIssuer` (see §B B4 for a migration-target gotcha hit while adding this)                                                                                                                                                                        | R1–R5       | done   |

phase gate: Phase 1's own tests (T3a) passed before Phase 2 started. All Phase 2 unit
(`packages/auth`, 120/120) and isolation (`apps/api/tests/isolation/api-key-external-org-mapping.isolation.test.ts`,
11/11) tests pass; `pnpm typecheck`/`pnpm lint` clean on all touched packages.

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-key-external-org-mapping.md and
docs/specs/third-party-key-external-org-mapping-tasks.md.

Implement Phase 1 tasks only (T2, T3, T3a -- T1 is already resolved/done).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- Before starting T2/T3, actually read the nexus-OW worktree's local fork of
  jwks.ts/dual-identity.ts (path known to the user) and run its approach
  through this repo's security.md checklist -- do not port it uncritically
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
