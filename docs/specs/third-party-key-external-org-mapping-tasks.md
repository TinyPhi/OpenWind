# Implementation Plan: Third-Party API Key — External-IdP Org Mapping

**Spec:** docs/specs/third-party-key-external-org-mapping.md
**Generated:** 2026-08-31
**Status:** not started

---

## Phase 1 — Multi-Issuer Verification Infra

**Goal:** `packages/auth` can verify a token against ANY configured issuer's JWKS and read that
issuer's own org-claim name — not just Zitadel's. No consumer wired up yet; this phase is pure
infra with its own tests, nothing user-visible changes.
**Gate:** all unit tests pass → then Phase 2

| task | task                                                                                                                                                                                                                                                                    | requirement | status |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1   | Resolved by spec-review: `externalIssuer` is always explicit admin input on `POST /api-keys`, never derived via a live discovery-document fetch at creation time (see spec §I)                                                                                          | R2, R4      | done   |
| T2   | Generalize `packages/auth/src/jwks.ts` to resolve JWKS per-issuer (cache multiple `JwksGetter`s keyed by issuer), not one static global source. Reconcile with `nexus-OW`'s existing local fork implementation, reviewed against `security.md` rather than ported as-is | R3          | todo   |
| T3   | Generalize `dual-identity.ts`'s org-claim read to resolve the claim NAME per-issuer (Zitadel: `urn:zitadel:iam:user:resourceowner:id`; AuthNexus: `org_id`) instead of hardcoding Zitadel's. Same `security.md` review caveat as T2                                     | R3          | todo   |
| T3a  | Unit tests: T2's per-issuer JWKS cache resolves the correct key set for 2+ distinct issuers, doesn't cross-contaminate; T3's claim-name resolution reads the right claim per issuer                                                                                     | R3          | todo   |

---

## Phase 2 — Schema, Validation, and Verification Wiring

**Goal:** an admin can create a third-party key that trusts a specific external IdP org, the
system enforces the mapping is present when actually needed, and request-time verification uses
it correctly.
**Gate:** all isolation tests pass + Phase 1 gate still green → §R acceptance criteria met

| task | task                                                                                                                                                                                                                                                                                  | requirement | status |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T4   | Migration: `external_issuer` (text, nullable), `external_org_id` (text, nullable) on `api_keys`. Analytics annotation + RLS unaffected (no new tenant-scoped table, existing `api_keys` RLS applies)                                                                                  | R1, R3      | todo   |
| T5   | `createApiKeyHandler`: extend `CreateApiKeySchema` with `externalIssuer`/`externalOrgId`; implement the 4-way validation from spec §I (omitted+omitted OK, issuer-equals-primary rejected, issuer-differs+orgId-omitted → `422 ORG_MAPPING_REQUIRED`, both-supplied+differs → stored) | R1, R2, R4  | todo   |
| T6   | `dual-identity.ts`: when the presented key has `external_issuer`/`external_org_id` set, verify against those (using T2/T3's per-issuer resolution) instead of `tenants.zitadel_org_id`; unset → today's path, byte-for-byte                                                           | R3, R5      | todo   |
| T7   | Isolation tests: R1 (single-IdP key unaffected), R2 (missing mapping rejected at creation, no row written), R3 (valid mapping stored + used at verification), R4 (redundant mapping rejected), R5 (`tenant-org-id-mapping.md` suite still green)                                      | R1–R5       | todo   |

phase gate: Phase 1's own tests (T3a) must pass before Phase 2 starts — Phase 2's validation
logic has nothing real to verify against at request time otherwise, only a schema change with no
working verification behind it.

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
