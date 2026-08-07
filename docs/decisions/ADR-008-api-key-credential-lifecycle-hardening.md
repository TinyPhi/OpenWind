# ADR-008: API Key & Credential Lifecycle Hardening (Agent Identity Deferred to a Named Gate)

**Status:** Accepted.  
**Date:** 2026-08-06.  
**Deciders:** Engineering lead, Platform architect.  
**Related to:** ADR-001 (multitenancy/RLS), ADR-006 (per-workflow ownership as a second
authorization path). Companion to ADR-009 (connector runtime), which is the actual near-term
consumer of identity concerns for Phase 3A — connector-initiated calls authenticate via the
existing `api_key` mechanism, not a new principal type (see Decision #1).  
**Supersedes:** —  
**Superseded by:** —

---

## Context

### Why this was rescoped

Rev.1/rev.2 proposed introducing a third principal type, `agent`, for AI/machine identity, plus a
delegation-chain audit field and a re-shape of `api_keys.scopes` from role-strings to
connector/action-strings. A second adversarial review round (security, operational-maturity,
completeness, and scope-discipline lenses, run independently) converged on three findings that
together argue for deferral rather than incremental fixing:

1. **No tracked requirement exists for it.** A repo-wide search for "autonomous agent," "agentic,"
   or "acting on behalf of" outside these two draft files returns nothing. Issue #18 (the AI
   layer, the track that would plausibly need this) is scoped entirely as human-in-the-loop: "admin
   reviews before save," "admin edits before applying," "human confirms" — explicitly, "AI features
   generate config... they never bypass the engine." An AI-proposed action that a human then saves
   is _already_ fully attributed via the existing `actor_type='user'` audit path; a
   `metadata.ai_generated: true` flag on that same row covers the near-term need without any new
   principal type or migration.
2. **The proposed model doesn't hold up to its own stated bar.** The delegation chain would be
   self-attested by the same in-process code that could be compromised — not cryptographic
   evidence (the actual precedent, AWS CloudTrail's `sts:AssumeRole` chain, is derived server-side
   from the credential, never from caller-supplied input). Proposed short-lived agent tokens have
   no real replay protection (no DPoP/mTLS sender-constraining) and no revocation mechanism beyond
   waiting for TTL expiry. Building a materially weaker version of "trace back to a well-defined
   entity" than the platform's own stated bar, for a feature nothing currently needs, is worse than
   not building it yet.
3. **`agent` collides with an existing, live concept.** `apps/api/src/routes/api-keys/create.ts:32`
   already defines `agent` as a **human RBAC role** (`ROLE_LEVEL = {user:0, agent:1, admin:2,
superadmin:3}` — a helpdesk agent). Introducing `principalType: "agent"` for machine identity
   into the same `AuthContext.roles`/`admin_audit_log.actor_type` surface risks exactly the kind of
   one-string-comparison-apart confusion that produces confused-deputy bugs later.

**This is a deferral with a named timeline, not an indefinite postponement** — see Decision #5.
(Pre-existing rev.3 numbering slip, corrected in rev.4 while reviewing this document.)

### What survives: real, non-speculative gaps in the existing model

Independent of the agent question, review found genuine gaps in how `human`/`api_key` principals
are handled today that are worth fixing now, because they're cheap and because they directly serve
the platform's own stated bar ("trace back actions to a human being... with clarity") for the
principals that already exist and are already in use:

- **`api_keys` has no `created_by` column, and key creation writes no audit entry.**
  `apps/api/src/routes/api-keys/create.ts` mints a key with no record of which human authorized it.
  This means the audit trail's "traces back to a human" claim is already false today for the
  `api_key` principal type that exists right now — not a hypothetical gap introduced by a future
  delegation model, a real gap in the current one.
- **`api_keys` has no expiry and no rotation support.** `packages/db/src/schema/platform.ts`'s
  `api_keys` table is `id, tenant_id, name, key_hash, key_hash_argon2, scopes, last_used_at,
created_at` — no `expires_at`, no `rotated_from`. `sk_` keys are immortal bearer secrets today.
  Stripe, GitHub (PAT expiry mandatory since 2023), Twilio, and Okta all treat this as a baseline
  control, not an advanced feature.
- **Revocation destroys the forensic record.** `apps/api/src/routes/api-keys/delete.ts` hard-deletes
  the row on revoke — kill latency is effectively immediate (verified: no cache extends a revoked
  key's life beyond its already-fetched-and-cached verification window), but there is no
  `revoked_at`/`revoked_by`, and `last_used_at` is destroyed along with the row. GitHub and Stripe
  retain revoked-credential records for exactly this reason — an incident investigation needs to
  know a key existed and was used, not just that it's gone now.
- **Legacy SHA-256-only keys (pre-migration `0047`) are both weakly hashed and immortal**, per
  `packages/auth/src/middleware.ts`'s documented interim-state acceptance (#291) — with no expiry
  forcing a resolution.

None of these require a new principal type, a delegation chain, or a scope-format change — they're
direct hardening of the mechanism that's already live.

---

## Decision (proposed)

1. **Connector-initiated calls (ADR-009) authenticate via the existing `api_key` mechanism,
   unchanged.** No new principal type for Phase 3A. A connector installation's audit rows record
   `actor_type = 'api_key'` with `metadata.connector_id` identifying which installation acted —
   zero migrations to `admin_audit_log`, zero change to `AuthContext`, and the audit trail
   correctly attributes every connector action to the API key (and, per Decision #2 below, the
   human who created it) rather than to an undefined machine identity.

2. **Add `api_keys.created_by` (Zitadel user id) and an audit-log entry on key mint and delete.**
   Additive migration — no existing read/write path breaks. This is the one fix that actually
   closes the "chain terminates at an anonymous key" gap, for the principal type that exists today,
   at low cost, independent of anything else in this ADR.

3. **Add `api_keys.expires_at` (nullable, defaulting to a platform-configured maximum lifetime for
   new keys) and a rotation flow (mint a replacement, dual-valid for an overlap window, then
   revoke the original).** Existing keys get `expires_at = NULL` initially, then a **90-day grace
   period** (proposed default, OQ-2) before being forced onto the new default lifetime — not
   silently expired, and not grandfathered indefinitely either.

4. **Introduce `revoked_at`/`revoked_by` columns; change key deletion from a hard delete to a soft
   revoke** (existing rows become unresolvable via `resolve_api_key_by_hash` by checking
   `revoked_at IS NULL` in that query, rather than via row absence) preserving the forensic record.
   A hard-delete admin action can still exist for actual data-retention/GDPR-driven purge, separate
   from routine revocation.

5. **Agent principal type and delegation-chain audit schema are deferred to a named gate: Phase 3C
   kickoff (issue #18).** At that point, re-evaluate against issue #18's _actual_ scope as it stands
   then — not a calendar date, because Phase 3 dates in this project are explicitly projected, not
   committed (per `docs/sup-docs/phase-timeline.md`'s own annotation). The re-evaluation rule:
   - If 3C's scope is still human-in-the-loop config generation (as currently written), this stays
     deferred, and the same rule re-applies at the next point 3C's scope is revisited.
   - If 3C's scope has expanded to include any AI-initiated action that commits without a human in
     the approval path, the agent/delegation model becomes a prerequisite for that specific
     capability and must be built to the full bar review round 2 identified as missing from the
     original draft — sender-constrained tokens (DPoP, RFC 9449, or mTLS per RFC 8705) rather than
     bearer tokens with only a short TTL, a cryptographically-derived delegation chain (in the
     shape of RFC 8693 token-exchange `act`/`may_act` claims, not a self-attested application-level
     field), and a real revoke-now path rather than expiry-only containment.

6. **The `api_keys.scopes` re-shape (role-strings → connector/action-strings) — this ADR's
   secondary trigger has already fired, per cross-review with ADR-010 (rev.2).** Rev.3's original
   wording named "the first real external API consumer... a partner integration" as the trigger for
   this specifically, independent of the agent question. ADR-010's Tier 1 (arms-length third-party
   partners) _is_ that consumer, and a cross-check during ADR-010's own revision found that Tier 1
   shipping on today's unchanged, role-scoped `api_key` mechanism would hand a partner integration
   the same blanket access as a real `agent`-role human across the entire tenant — not "create
   tickets via this integration." **This ADR now commits to building the scopes re-shape as a
   prerequisite for Tier 1 (ADR-010), not waiting for Phase 3C.** The agent/delegation deferral in
   Decision #5 is unaffected — this is only the scopes-format change, decided independently of the
   agent question exactly as rev.3 originally scoped it. See ADR-010's own revision for the Tier
   1-side decision; the schema/enforcement work itself belongs to this ADR since it's the
   `api_keys` table. **The "create tickets via this integration" example above is not
   hypothetical** — see OQ-5 for the concrete taxonomy shape, informed by the actual known Tier 1
   partner's use case (ticketing primary, RBAC-scoped record reads). **Dual-format column, needs
   a discriminator:** since OQ-6 keeps existing internal keys on legacy role-strings while new
   Tier 1 keys use the new `entity:<type>:<verb>` action-strings, `api_keys.scopes` will hold both
   formats simultaneously with nothing in this ADR specifying how enforcement code tells them
   apart at read time. Whoever implements must pick one: a colon-presence heuristic (fragile if a
   future role-string ever contains a colon), an explicit `scopes_format` column (`role` |
   `action`), or a `created_at`/migration-date cutoff. Flagged here so it isn't discovered cold
   during implementation.

---

## Consequences

### Positive

- Closes a real, present-day traceability gap (`created_by`/audit-on-mint) for the principal type
  that's actually in use, at essentially zero cost or risk — this doesn't wait on anything else in
  this ADR.
- Avoids building a security-critical mechanism (agent identity, delegation) to a standard review
  found inadequate, for a requirement that doesn't exist yet. When it's needed, it gets built
  properly instead of being retrofitted under production pressure.
- No collision risk: `agent` stays exactly what it is today (a human RBAC role) until there's an
  actual reason to introduce a second sense for the word, at which point a non-colliding name
  (`machine`, `service`, `delegate`) should be chosen deliberately, not defaulted into.
- Directly enables ADR-009's Decision #1 (connector calls authenticate as `api_key`) without
  waiting on any of this ADR's more speculative content — the two ADRs no longer have a dependency
  in the direction that used to block ADR-009 on ADR-008's harder open questions.
- Building the scopes re-shape now (Decision #6) closes a real over-grant risk before ADR-010's
  Tier 1 partner keys exist, rather than shipping partner integrations on today's role-scoped keys
  and re-scoping under pressure once a partner already depends on the coarse behavior.

### Negative and mitigations

- **Key rotation and expiry (Decisions #3/#4) are real schema and flow work**, not free — a
  migration, a rotation UI/API, and a grace-period decision for already-issued keys (OQ-2).
  Mitigation: none of it is gated on the deferred agent/delegation content, so it can ship
  independently and sooner.
- **The Phase 3C gate is a re-evaluation point, not a guarantee the work won't be needed sooner.**
  If a pilot customer request or a security review surfaces a concrete near-term need for
  delegated machine identity before 3C, this ADR's deferral should be revisited immediately rather
  than held to the letter of "wait for 3C" — the gate is the _latest_ point of re-evaluation, not
  the _only_ one.
- **Legacy SHA-256-only keys (#291) now have a forcing function** — a 30-day rotation deadline
  (proposed default, OQ-3), tighter than the general 90-day grace period since they compound weak
  hashing with immortality. Exact windows for both still need sign-off from whoever owns the
  resulting support/breakage burden.
- **The scopes re-shape (Decision #6) is now real, non-deferred schema and enforcement work** —
  designing an action-string taxonomy, migrating existing keys' role-strings to it, and updating
  every `requireRole`/scope-check call site that reads `api_keys.scopes` today. Not free, but
  smaller than it would be after a real partner depends on the coarse behavior (OQ-5).

---

## Open Questions

| ID   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-1 | **Resolved:** `packages/auth`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Consistent with where `requireRole`/rate-limit enforcement already live — no new module needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| OQ-2 | **Resolved in principle (2026-08-05): a grace period, not an unbounded grandfather clause.** Proposed default, exact window not yet confirmed: 90 days from this ADR shipping, notified in advance, before existing keys are forced onto the new `expires_at` default lifetime.                                                                                                                                                                                                                      | Confirm the exact window with whoever owns customer/partner communications before implementation — this affects any existing integration depending on a currently-immortal key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| OQ-3 | **Resolved in principle (2026-08-05): yes, a forced-rotation deadline, tighter than OQ-2's general grace period.** Proposed default: 30 days, given legacy SHA-256-only keys (#291) compound two risks (weak hashing _and_ immortality) rather than just one.                                                                                                                                                                                                                                        | Same confirmation caveat as OQ-2 — exact window needs sign-off from whoever owns the resulting support/breakage burden, not just the security rationale for urgency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| OQ-4 | **Resolved (2026-08-05):** an explicit checklist item in `.claude/context/phase-3-primer.md` once written (per Next Steps #3), not a named owner.                                                                                                                                                                                                                                                                                                                                                    | No new ownership structure — folded into whatever process already kicks off 3C planning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| OQ-5 | **Resolved in shape (2026-08-05), confirm exact naming at implementation.** Informed by the known Tier 1 partner's actual need (ticketing primary; reading records, RBAC-scoped, to inform details/status): entity-type-scoped action strings, `entity:<entityType>:<verb>` — e.g. `entity:ticket:create`, `entity:ticket:read` — rather than per-module CRUD or a coarse read/write/admin split. Generalizes past "ticket" to any entity type since the engines are generic, not helpdesk-specific. | **`read` must compose with existing field-level RBAC, not bypass it** — reuse ADR-009 Decision #10's sensitivity taxonomy/redactor (already built for connector-outbound payloads: `pii`/`financial`-classified fields need an explicit grant to cross the tenant boundary) rather than inventing a second redaction mechanism for Tier 1 reads. A Tier 1 key scoped to `entity:ticket:read` should see the same redacted view a human at an equivalent role would, never an unconditional raw dump. **Still open:** whether the partner needs a `transition` verb (advancing ticket workflow state, e.g. closing a ticket) or `create`+`read` alone are sufficient — confirm at implementation time before finalizing the verb set. |
| OQ-6 | **Resolved (2026-08-05):** only newly-minted Tier 1 partner keys use the new action-string format.                                                                                                                                                                                                                                                                                                                                                                                                   | Existing internal `api_key`s keep working under today's role-scopes, unmigrated — smaller blast radius, no forced rollout touching working internal tooling. Revisit only if a concrete reason to migrate them surfaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## Implementation next steps

1. Implement Decisions #2-#4 (`created_by`, audit-on-mint, expiry, soft-revoke) as their own PR,
   independent of and not blocked by ADR-009 — this is real, needed work regardless of connector
   runtime timing.
2. Record Decision #5's gate explicitly somewhere it will actually be seen at Phase 3C planning
   time (`docs/sup-docs/roadmap-tracker.md`'s 3C entry and `.claude/context/phase-3-primer.md`) —
   a deferred decision that only lives in this ADR risks being missed entirely when 3C planning
   actually starts.
3. Resolve OQ-5 (action-string taxonomy) jointly with whoever scopes ADR-010's Tier 1 rollout —
   Decision #6 is a prerequisite for Tier 1's first partner key, not independent follow-up work.
4. Add an isolation-test pass for the `api_keys` migrations (Decisions #2-#4 and #6) per this
   repo's own `testing-conventions.md` mandate for new columns/enforcement paths on a tenant-scoped
   table.
