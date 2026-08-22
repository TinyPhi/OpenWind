# Implementation Plan: Third-Party API — Phase A: Key Management

**Spec:** docs/specs/third-party-api-phase-a-key-management.md
**Generated:** 2026-08-17 (updated 2026-08-18 — Round 7 changed R8 from a coarse permission
tier to the platform's real action-scope system; T1/T2/T8/T9 below reflect that. Updated
2026-08-20, post PR A1 review — T1's column list corrected to match what migration 0068
actually shipped, per PrabhuVijit's review on PR #439: `scopes`, `expires_at`, and
`rotated_from`/`rotation_predecessor_id` already existed on `api_keys` from ADR-008 and were
reused rather than duplicated; `status` and `rotation_successor_id` were never added — both are
derivable from existing columns instead. Updated 2026-08-22, post PR A5 merge — Phase 2 and
Phase 3 both closed; see per-task status below for which PR (or pre-existing code) closed each.
Updated again 2026-08-22 — Phase 4 (T9/T10) closed via a systematic post-merge test-gap sweep and
whole-surface security review; **Phase A is now fully done, all four phases closed.**)
**Status:** Phase 1 (T1) done — PR #439. Phase 2 (T2–T7) done — PRs #440/#446, T6/T7 via
pre-existing code (PR A4 skipped, see T6/T7 rows). Phase 3 (T8) done — PR #449. Phase 4 (T9/T10)
done — see rows below for the 3 gaps found and closed. **Phase A complete — Phase B's `/spec` is
now unblocked.**

---

## Phase 1 — Data Model

**Goal:** `api_keys` carries every field Phase A's lifecycle logic and later phases (aud check,
expiry notification) need, with the constraints that make those features correct.
**Gate:** migration applies cleanly, unique constraint on `zitadel_client_id` (active keys only)
enforced at the DB layer → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | requirement     | status         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | -------------- |
| T1: Migration (0068) — add `application_name`, `application_description`, `application_contact_email`, `zitadel_client_id` to `api_keys`; partial unique index on `zitadel_client_id` scoped to active (non-revoked) keys. Reuses the existing `scopes`/`scopes_format`, `expires_at`, and `rotated_from` columns from ADR-008 instead of adding parallel ones; does not add a `status` column or a `rotation_successor_id` column, both fully derivable from existing columns. RLS/grants unchanged (already present on `api_keys`); analytics annotation on the migration (column-additions-only, no new table). | R6, R7, R8, R11 | done — PR #439 |

---

## Phase 2 — API / Service Layer

**Goal:** Mint, Revoke, Rotate, Emergency Rotate, expiry enforcement, and disconnect all behave
exactly per §R — including the 2-key lineage cap and Emergency Rotate's taint propagation.
**Gate:** integration tests pass + Phase 1 gate still green → then Phase 3

| task                                                                                                                                                                                                                                                                                                                                                                                      | requirement | status                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| T2: Mint endpoint — require non-empty `scopes` validated against the known vocabulary (reject unknown scope strings), validate application record fields, enforce Client ID uniqueness (including reclaiming an expired-but-not-yet-revoked key's Client ID by auto-revoking it, since migration 0068's partial index can't exclude that case on its own), stamp `expires_at` = now + 3mo | R6, R7, R8  | done — PR #440                                                                    |
| T3: Revoke endpoint — instant hard-kill, no grace, no stale-auth window                                                                                                                                                                                                                                                                                                                   | R2          | done — pre-existing (`delete.ts`, ADR-008)                                        |
| T4: Rotate endpoint — issue successor with 24h grace on predecessor; before creating the new rotation, instantly kill any existing dying predecessor in this lineage (caps lineage at 2 nodes)                                                                                                                                                                                            | R3, R4      | done — PR #446                                                                    |
| T5: Emergency Rotate endpoint — instant kill of target key; if target has a live successor (mid-grace-window case), kill that too and issue one genuinely fresh key covering both                                                                                                                                                                                                         | R5          | done — PR #446                                                                    |
| T6: Auth middleware — reject a key past `expires_at` via the same rejection path as revoked (no second \"expired\" branch)                                                                                                                                                                                                                                                                | R6          | done — pre-existing (migration 0053's `resolve_api_key_by_hash()`); PR A4 skipped |
| T7: Disconnect/decommission action — instant kill, reuses Revoke's path, works even mid-rotation-grace                                                                                                                                                                                                                                                                                    | R9          | done — pre-existing (functionally identical to Revoke); PR A4 skipped             |

---

## Phase 3 — Consumer UI

**Goal:** Admin can see and act on every key's full lifecycle state from one screen, including
expiry health, without needing to query the database directly.
**Gate:** §R acceptance criteria for R10 met, manually verified in the running admin-ui → then
Phase 4

| task                                                                                                                                                                                                                                                                                                                                                                       | requirement | status                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| T8: Key Management screen — list (app name, created-by, created-at, expiry, scope preset/summary, status) + create form (all Phase 1 required fields, Read-only/Read-write one-click presets mapping to `scopes` plus a custom-scope picker) + Revoke/Rotate/Emergency-Rotate row actions + amber (≤30d) / red (past) expiry states computed client-side from `expires_at` | R10         | done — PR #449 (Settings tab, not a standalone route; also grew a `PATCH` edit endpoint for description/contact-email, not in the original scope) |

---

## Phase 4 — Verification & Ship

**Goal:** Every §R acceptance criterion has a passing test; PR is reviewed and shippable.
**Gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation` all green; `/review`

- `/security-review` clean; docs marker written.

| task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | requirement | status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T9: Tests — revoke-is-instant; rotate-dies-at-exactly-24h; lineage-never-exceeds-2 (both the "rotate the successor before predecessor's grace ends" and "emergency-rotate a mid-grace pair" cases); emergency-rotate-distinct-from-rotate; read-only-scoped-key-rejected-on-write-regardless-of-real-access; unknown-scope-string-rejected; scopes-immutable-after-creation; expires-at-exact-3-month-mark; disconnect-kills-instantly-even-mid-grace; Client-ID-uniqueness-rejected; missing-required-field-rejected; UI status/scope-preset/expiry-badge correctness | R1–R12      | done — systematic sweep run against every R1–R12 sub-clause post-merge (2026-08-22); found and closed 3 real gaps: R1 (new static guard test, `mint-paths.architecture.test.ts`, fails if any `api_keys` insert-with-key-hash path appears outside the three known admin-gated routes), R3 (tightened `rotate.test.ts`'s loose 0–25h bound to an exact-24h±5s assertion), R9 (new isolation test proving a mid-rotation-grace revoke kills instantly against real Postgres, not just inferred from shared code path). R12 confirmed genuinely out of scope for Phase A per its own spec text (deferred to Phase B's response middleware) — not a gap. R11 confirmed as a schema-level guarantee (DB-generated UUID PK) needing no dedicated test. |
| T10: `/security-review`, `/review`, docs marker (`write-docs-marker.sh --touched`), commit procedure, PR                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —           | done — whole-surface (not per-PR-diff) security review run 2026-08-22 across every merged Phase A route/middleware/schema file; no exploitable findings (tenant isolation, cross-tenant Client-ID handling, scopes immutability, 404-not-403, admin-gating, rate limiting, error handling all verified holding as a complete system)                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## Kick-Off Prompt

Copy this into your Claude Code session to start implementation:

```
Read docs/specs/third-party-api-phase-a-key-management.md and
docs/specs/third-party-api-phase-a-key-management-tasks.md.

Implement Phase 1 tasks only (T1).

Rules:
- Do not begin Phase 2 until T1's migration is applied and its unique-constraint test passes
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
