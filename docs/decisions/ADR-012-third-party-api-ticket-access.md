# ADR-012: Third-Party API Access to OpenWind Tickets

**Status:** Accepted.  
**Date:** 2026-08-20.  
**Deciders:** Feature author + external design reviewer (7 rounds, see Context).  
**Related to:** ADR-008 (API Key Credential Lifecycle Hardening — this ADR adopts its
`api_keys` mechanism and extends it with action-scopes and a Zitadel Client ID field), ADR-010
(Inbound Partner API — this is the concrete Tier-1 implementation ADR-010 anticipated),
ADR-001 (Multitenancy/RLS — tenant-match enforcement here reuses that model).  
**Supersedes:** —  
**Superseded by:** —

**Full behavioral detail lives in `docs/third-party-api-design.md` (canonical) and
`docs/third-party-api-enablement-phases.md` (phased implementation plan) — this ADR captures
the decisions and their rationale, not every endpoint/limit/header. Read those two documents
for anything this ADR doesn't answer.**

---

## Context

External applications need to create and manage OpenWind support tickets via API — without a
human logging into OpenWind itself — while keeping every action attributable to a real person
and governed by the same access rules as the UI. This rides on top of ADR-008's `api_key`
mechanism and is the concrete Tier-1 partner-API slice ADR-010 anticipated but left unspecified.

The design went through 7 rounds of review before implementation began (2026-08-14 to
2026-08-20): an initial interview-driven draft, an external security review (12 findings),
two internal adversarial passes (11 + 4 findings), a second external review (6 further
architectural findings plus 2 additions), a sixth round triggered by a reviewer who,
asked to produce an ADR from this design, instead authored a full competing ADR draft
independently — cross-checking it surfaced one genuine unresolved gap (attachment scan-failure
handling) plus a worthwhile third rate-limit tier and a couple of smaller hardening details —
and a seventh round, a further independent security review of a similar competing ADR draft,
which surfaced one HIGH finding (a tenant-purge gap in exactly the same compliance class as
round six's rate-limit/logging hardening, but reaching a different field) and three MEDIUM
findings (a mention-resolution timing side-channel, an unspecified presigned-URL scope, and an
underspecified idempotency-hash algorithm). Three rounds' findings changed the architecture
materially enough to be called out as their own decisions below (#3/#6 from round 5, #8 and part
of #6 from round 6, and refinements to #6/#7/#9 from round 7). The full history of what was
found and how it was resolved is in `docs/third-party-api-design.md`'s inline round-by-round
annotations and change log — not reproduced here.

---

## Decision

1. **Every API request carries two independently-verified identities: the application (API
   key) and the acting person (a real Zitadel-issued token), never just one.** A key alone is
   never sufficient to attribute an action to a person — the person's own short-lived access
   token (from logging into the third-party application) is forwarded and verified exactly as
   OpenWind verifies a direct human login: signature, issuer, expiry, tenant/org membership,
   and — critically — **audience (`aud`)**, checked against a Zitadel Client ID registered
   per-key at creation time (not a single shared "OpenWind" value, which would not match any
   legitimate token given how these tokens actually flow). A local 15-minute max-token-age
   check is enforced independent of Zitadel's own configured expiry, so this feature's
   freshness guarantee doesn't silently degrade if that external setting is ever changed for
   an unrelated reason.

2. **No fallback identity tier.** An earlier draft included an admin-curated "approved
   identity list" fallback (Tier 2) for applications not using Zitadel-based login. This was
   built, then explicitly dropped: it's a strictly weaker guarantee than token-based
   verification, no real non-SSO integration has ever been named as needing it, and shipping
   an unused, harder-to-audit fallback was judged worse than building it later against an
   actual requirement if one materializes.

3. **Key permissions are the platform's existing action-scope system
   (`entity:ticket:<verb>`, from ADR-008/migration 0055) from day one — not a separately-built
   coarse tier.** The original plan was a simple read-only/read-write boolean, with real
   per-action scoping deferred as a prerequisite only before external issuance. Once it was
   established the real scoping system already exists in the codebase, building the coarse
   tier first would have meant either throwing that work away or never adopting the real
   system. "Read-only" and "Read-write" survive only as two creation-time UI presets mapping
   to fixed scope sets — the actual enforcement is always scope intersection (key scopes ∩
   person's real RBAC ∩ tenant RLS), with no separate boolean check anywhere in the schema.
   This also removes the former "internal-testing vs. external-ready" scoping gap entirely.

4. **Every ticket-level action requiring existing access (comment, fetch, transition,
   sub-ticket) is gated by the ticket's own access list — the same list the UI already
   enforces.** Creating a new ticket has no such gate (any authorized application/person can
   create), but the creator identity is always recorded. A person not on a ticket's access
   list gets the identical response whether the ticket exists or not, closing a
   ticket-existence oracle.

5. **Privilege escalation is always human-approved; no API can grant elevated access to
   itself or check access in advance.** Tagging an unlisted-but-workflow-known person can, per
   a per-workflow toggle defaulting **off**, either auto-grant read-only (matching pre-existing
   UI behavior) or create a human-approvable access request — defaulting off because a single
   unauthorized read-grant on one sensitive ticket (an HR case, a security incident) was judged
   a real problem on its own, not just a volume concern. Escalating to write (comment) access
   always goes through the existing access-request/approval flow; there is no path, ever, to
   obtain transition/edit rights this way — those remain reserved for creator/assignee/workflow
   admin, identically for API and human callers. **Mention resolution itself runs fully
   asynchronously, after the comment-posting request already returns** — not inline within that
   request. An identical API response across all three tagging outcomes (already-has-access,
   auto-grant/access-request, no-access) closes the leak at the response level, but the three
   outcomes still do materially different amounts of DB work if resolved synchronously, which is
   itself a measurable timing side-channel for enumerating valid usernames. Making resolution
   async (a background worker, mirroring how the attachment AV scan already works) removes
   timing as a signal entirely instead of narrowing the gap — at the cost of the access
   grant/request notification landing a beat after the comment appears, rather than instantly.

6. **File attachments use a presigned, direct-to-storage upload flow, not file content
   embedded in the ticket/comment JSON request.** An earlier draft sent files base64-encoded
   inside the same JSON body, reasoning that reusing the existing JSON validation pipeline
   avoided a second parser as attack surface. That held for one small file, but the allowed
   limits (10 files × 10MB) meant a single request could carry ~133MB of base64 text requiring
   full in-memory buffering — a genuine DoS/memory-spike risk, not just a theoretical one. The
   flow now follows the Stripe/GitHub/S3 pattern: request an upload slot (expires after 5
   minutes if unused) → `PUT` raw bytes directly to storage → reference the resulting
   attachment ID when creating the ticket/comment. File bytes never reach OpenWind's JSON
   parser. **The upload slot's presigned URL is explicitly object-key-scoped to that one exact
   storage path, valid for exactly one PUT — never scoped to the tenant's whole storage prefix.**
   A prefix-scoped URL would let its holder overwrite a different, already-scanned,
   already-linked attachment after the fact; pinning it to one key for one PUT closes that off. **Ticket/comment creation does not block on the AV scan finishing** — it succeeds
   immediately with the attachment in a `scanning` state; only the download is gated on the
   scan reaching `ready`, and downloads carry `Content-Security-Policy: sandbox` alongside the
   existing filename-sanitized `Content-Disposition` header. **If the scan later fails,** the
   attachment is quarantined and the ticket/comment gains an automatic system note explaining
   why, fully logged and raising an admin alert — the third party is not actively notified,
   since its original request already returned success and building a one-off notification
   channel for this case would overlap with the separate connector/webhook-gateway initiative
   (ADR-009); it sees the note the normal way if it reads the ticket back.

7. **Every application/person action is logged to a dedicated, admin-only Access Logs
   screen — separate from the ticket's own timeline, which only shows successful actions.**
   The dual identity is recorded as actor type `api_key` plus a separate field always carrying
   the acting person's identity, so investigation works whether searching by key or by person.
   Automated misuse alerts (repeated auth failures, volume spikes, tagging-cap breaches)
   proactively notify admins rather than relying on manual review. Detailed log rows age out
   on a rolling 90-day window; aggregate counts are retained long-term; a tenant purge
   triggers immediate anonymization of that tenant's rows (not deletion of the row itself),
   closing a live DPDP/GDPR compliance gap rather than an indefinite-retention stance. **Purge
   anonymization must explicitly reach the acting-person field described above, not just the
   application-identity columns** — whatever that field's underlying storage shape turns out to
   be at implementation time (a plain column vs. a value nested in a JSON blob), a purge
   statement scoped only to named columns can silently miss a nested value entirely, leaving real
   personal data intact despite an apparently-successful purge. This is called out as its own
   required, separately-tested implementation step, not assumed to fall out of the column-level
   fix for free.

8. **Three-tier rate limiting: per (key, person), per key, and per tenant.** 20 req/min per
   application-and-person pair prevents one person's usage from starving others on the same
   key; 200 req/min per key bounds a key's total traffic regardless of how many people act
   through it (the per-person tier alone doesn't bound this — a key fanning out across many
   valid people could otherwise scale unbounded); and a **per-tenant configurable ceiling**,
   admin-editable and defaulting to a sane platform-wide value, bounds a tenant's aggregate
   traffic across every key it holds combined. The tenant tier is deliberately not tied to a
   pricing/plan model (none exists today) — a forward-compatible seam so a future plan tier can
   simply supply this same field's default later, without rework.

9. **Idempotency keys (caller-supplied, per action) prevent duplicate execution on retry,
   scoped to `(api_key_id, tenant_id, acting person)`.** Same key + same canonicalized content
   returns the cached result; same key + different content is rejected as a conflict. A
   short-lived (30s), first-come-first-served lock prevents two simultaneous identical requests
   from both executing before either caches a result — a concurrent duplicate gets `409` with a
   short `Retry-After`, not queued to wait. **"Canonicalized content" means RFC 8785 (JSON
   Canonicalization Scheme) applied to the request body**, not an informally-described
   sorted-keys rule — RFC 8785 already answers the ambiguities (key sort depth, array ordering,
   Unicode normalization, numeric formatting) an in-house definition would otherwise leave open,
   any of which could cause two SDKs to hash the same logical request two different ways and
   turn a legitimate retry into a false conflict rejection.

10. **Key lifecycle: human-only minting, instant revoke, 24h-grace rotate, a distinct
    "Emergency Rotate" for suspected compromise, and automatic 3-month expiry.** Rotation
    lineage is capped at two keys (one dying, one active) — a second rotate during an active
    grace window kills the dying predecessor instantly rather than growing a longer chain.
    Emergency Rotate treats a live rotation pair as one tainted unit, killing both. Every key
    requires a formal application record (name, admin contact email, Zitadel Client ID) rather
    than a free-text label — the contact email unblocks a deferred expiry-notification
    fast-follow, and the Client ID is what makes Decision #1's audience check correct.

---

## Consequences

### Positive

- Impersonation is cryptographically bounded to real, currently-valid, correctly-audienced
  Zitadel tokens — not merely a claimed identity, and not a key alone.
- No throwaway authorization work: the real action-scope system is live from the first key
  minted, with no gap between internal testing and external readiness on that dimension.
- The attachment flow removes a genuine DoS vector at its architectural root rather than
  capping around it, matching how comparable partner-facing APIs (Stripe, GitHub, S3) already
  solve this.
- Every workflow gets a real choice about whether mention-driven access grants are automatic
  or human-approved — a single confidential-ticket exposure is treated as seriously as a mass
  one.
- Log retention now has an actual, defensible compliance posture (rolling window + prompt
  anonymization on erasure) instead of an open-ended "revisit later."

### Negative and mitigations

- **The presigned-upload flow is a bigger integration surface for third parties than a
  single API call** — a 3-step flow instead of 1, plus a new orphaned-upload cleanup job on
  OpenWind's side. Mitigation: this is the industry-standard shape; any partner integrating
  with a comparably-sized API has almost certainly built this pattern before.
- **Dropping Tier 2 (Decision #2) means any future non-SSO third party has no fallback path
  at all** until one is designed against a real requirement. Mitigation: no such requirement
  exists today; building it now would have been speculative, unreviewed code.
- **The per-workflow auto-grant-off default (Decision #5) adds an approval step to a
  previously-frictionless UI behavior** for every workflow that doesn't explicitly opt back
  in. Mitigation: this is a one-time per-workflow admin setting, not a per-mention cost.
- **The dual-identity audit schema (Decision #7) requires a new column/field on the existing
  `admin_audit_log`**, not just a value change to `actor_type`. Mitigation: additive migration,
  no existing read/write path breaks, consistent with how ADR-008 already extended this table.
- **Async attachment scanning (Decision #6) means a ticket/comment can briefly exist referencing
  an attachment that later fails validation and gets quarantined.** Mitigation: this window is
  bounded by the AV scan's own duration (typically seconds), the failure path is fully specified
  (system note + admin alert), and the alternative — blocking every ticket/comment creation on a
  synchronous scan — was judged worse for API responsiveness across the overwhelming majority of
  clean-file cases.
- **Async mention resolution (Decision #5) means a tagged person's access grant or access-request
  notification lands a beat after the comment itself appears, not instantly.** Mitigation: this
  is the same trade-off already accepted for attachment scanning, expected to be low-latency
  (milliseconds to a few seconds under normal load), and it's the only way to fully remove the
  timing side-channel rather than just narrowing it.

---

## Deferred Decisions

| Deferred Item                                                                                         | Trigger to Revisit                                                                                                                                 | Why Deferred Now                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless/system accounts (`actor_type = 'system'`, not tied to any acting person)                     | A concrete in-house sibling product needing non-interactive background sync                                                                        | Preserves the strict human-attribution standard this design is built around; no real day-one consumer exists. Consistent with ADR-008/ADR-010's own deferral of speculative machine-identity work. |
| Field-level read redaction beyond existing workflow RBAC                                              | A partner integration needing partial field masking within a ticket it can otherwise fully read                                                    | Existing workflow RBAC + the sensitivity redactor (ADR-009 Decision #10) already governs what a read-scoped key sees, matching an equivalent-role human — sufficient for v1.                       |
| Active outbound notification to a third party when its own uploaded attachment fails an async AV scan | A general-purpose outbound webhook/callback channel exists for this API (would ride on the separate connector/webhook-gateway initiative, ADR-009) | Building a one-off notification channel for this single case is disproportionate; the third party can already see the failure by reading the ticket/comment back through the API it already uses.  |

---

## Open Questions

| ID   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | How/when to notify an application owner their key is nearing 3-month expiry (email or similar).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Correction (2026-08-24):** only the Key Management UI badge actually shipped (`apps/admin-ui/src/pages/api-keys/index.tsx`) — the `X-API-Key-Expires-At` response header claimed above does not exist in `apps/api/src`. Track the header as an actual follow-up task, not evidence this OQ is closed; the email-notification piece remains genuinely deferred as originally stated. |
| OQ-2 | **Partially resolved (2026-08-24):** the access-grants-via-tagging cap is now pinned at 5 grants/ticket/hour (`AUTO_GRANT_RATE_LIMIT`/`AUTO_GRANT_RATE_WINDOW_SECONDS`, PR #470). **Still open:** the per-tenant rate-limit ceiling specific to third-party partner-API traffic — `RATE_LIMIT_TENANT_PER_MIN` (600/min default) is the pre-existing general tenant limit (issue #195), not partner-API-specific; no dedicated ceiling was found. This is exactly the gap ADR-013 (`docs/decisions/ADR-013-unified-rate-limiting-strategy.md`, accepted 2026-08-24) already designs a mechanism for — Decision #4's tier-assignment work resolves this remainder once implemented. | Tagging cap confirmed via PR #470 diff.                                                                                                                                                                                                                                                                                                                                                |
| OQ-3 | Whether Access Log retention (90-day rolling + purge-anonymization) needs a _formal_ documented policy beyond this ADR/design doc, if a partner's DPA later demands one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Current policy is believed DPDP/GDPR-consistent; revisit if a concrete external requirement says otherwise.                                                                                                                                                                                                                                                                            |

---

## Implementation next steps

1. ~~This ADR should be reviewed and formally accepted...~~ **Resolved (2026-08-24):** this item was stale leftover text from when this document was drafted under a filename that collided with the separately-accepted plugin-system ADR-011 and had to be renumbered to ADR-012 (see issue #471 for the governance note on how acceptance happened — that issue also covers this exact stale-text finding). It's already filed under `ADR-012`, already `Status: Accepted`. Nothing further to do here.
2. Phase A (`docs/specs/third-party-api-phase-a-key-management.md`) already reflects Decisions #3 and #10, including round 7's partial-unique-index carve-out for `zitadel_client_id` (active keys only) — its plan-lock is drafted and awaiting `approve-plan`.
3. Phases B–G (per `docs/third-party-api-enablement-phases.md`) implement the remaining decisions in dependency order; each phase's `/spec` should cite this ADR alongside the design doc.
4. **Resolved (2026-08-24):** added to `CLAUDE.md`'s reference list, alongside ADR-011 (which had the same gap, unflagged). Not yet added to `.claude/context/` — no phase-3-primer-style content
   specific to this ADR exists yet; add if/when that's written.
