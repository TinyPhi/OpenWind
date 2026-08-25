# ADR-010: Inbound Partner API & Trusted Service-to-Service Integration

**Status:** Accepted.  
**Date:** 2026-08-06.  
**Deciders:** Engineering lead, Platform architect.  
**Supersedes:** —  
**Related to:** ADR-001 (multitenancy — Zitadel org↔tenant mapping, already shipped per PRs
#151/#152, is the foundation Decision #2's OAuth-reuse depends on), ADR-008 (API key lifecycle —
Tier 1 of this ADR uses that mechanism with the scopes re-shape ADR-008 Decision #6 commits to,
not unchanged; Tier 2's principal-type work is deferred, see Deferred Decisions), ADR-009
(connector runtime — this ADR's webhook-subscription model, Decision #3, reuses its outbound
delivery infrastructure rather than building a third pipeline).

**Superseded by:** —

---

## Context

### Why this ADR exists — a genuine gap, not a formalization of existing scope

Unlike ADR-008 and ADR-009, which formalize already-tracked work (issue #16's Core scope), **no
GitHub issue or roadmap phase currently scopes the inbound direction**: third parties or other
company products calling _into_ OpenWind's own API, receiving webhooks _from_ it generically, or
authenticating as anything other than a human user or a static tenant-issued API key. Confirmed by
direct search (2026-08-04): the only place a partner/developer-facing API is even mentioned is
`docs/platform-vision.md`'s Phase 6 "Developer Platform" section — an uncommitted vision doc with
no corresponding issue, three phases past where the platform is now. Issue #16 (covered by
ADR-009) is entirely outbound: OpenWind calling _out_ to Slack/email/WhatsApp through its own
connector runtime. This ADR covers the opposite direction, per explicit product decision to pull it
into Phase 3A rather than leave it for a later, uncommitted phase.

**rev.2 verification:** given Tier 2's justification didn't survive a direct check (see Decision
#1), the same check was applied to Tier 1 before trusting this ADR's own premise — **confirmed
2026-08-05: a concrete Tier 1 partner integration exists/is planned**, unlike Tier 2. This is the
difference between the two tiers that justifies building one now and deferring the other, not an
asymmetric standard applied without checking.

### Two distinct callers, confirmed by explicit product decision, requiring two distinct trust models

Per direct clarification (2026-08-04): "other in-house products" means **separate products built
by the same company**, not OpenWind's own modules (already governed by CLAUDE.md's dependency
rules) and not arms-length third parties. This is a materially different trust relationship from a
random partner integration, and conflating them would either over-privilege partners or
under-privilege sibling products:

- **Tier 1 — arms-length third-party partners.** Customer-facing integrations built by companies
  OpenWind doesn't control: partner apps, a customer's own scripts, marketplace-adjacent
  integrations. Should stay single-tenant scoped, revocable per-tenant, and never get
  cross-tenant/platform-level access.
- **Tier 2 — trusted in-house sibling products.** Other systems built by the same company. These
  may legitimately need cross-tenant or platform-level operations (e.g. provisioning, cross-product
  identity sync) that would be a severe over-grant for Tier 1. Conflating the two into one
  mechanism (as `agent` almost did in ADR-008's original draft) would force a choice between
  under-serving Tier 2's real needs or over-granting Tier 1's arms-length integrations.

### What already exists that this design should reuse

> **rev.2 correction:** the two bullets below on Tier 2 (the `notification-outbound-auth.ts`
> precedent and the `system`-vs-new-value reasoning) described _why_ a mechanism for Tier 2 would
> be built a certain way — they're kept as-is for the paper trail, but rev.2 found the premise
> underneath them ("Tier 2's need is real, named, and near-term") unsupported: no concrete
> day-one consumer exists. See Decision #1 and Deferred Decisions. The reasoning below still
> applies _whenever_ Tier 2 is actually built — it's the "how," not invalidated — only "build it
> now" is reversed.

- **Zitadel already supports OAuth2 authorization-code + consent flows, and already models
  multi-tenant orgs** (confirmed via Zitadel's own documentation, 2026-08-04) — "an organization can
  represent a business partner," with project-scoped role assignments across orgs. OpenWind's
  Zitadel org↔tenant mapping is already shipped (PRs #151/#152, per `CLAUDE.md`). This means a
  Tier 1 OAuth/consent flow is largely a **Zitadel configuration and claims-mapping decision**, not
  a bespoke authorization server to build — `packages/auth/src/jwks.ts` already verifies
  Zitadel-issued JWTs; a partner-app-issued token is the same verification path with a different
  claim shape to map to scopes.
- **The existing `notification-outbound-auth.ts` machine-identity precedent** (Zitadel service
  account, JWT-bearer grant) is the right mechanism for Tier 2 — the same pattern ADR-008 declined
  to generalize for speculative AI-agent identity is a good fit here because Tier 2's need is real,
  named, and near-term, not speculative.
- **ADR-009's outbound delivery decisions** (dedicated queue pattern, HMAC signing, versioned
  envelope, delivery-attempt record, per-installation kill switch) are the right infrastructure to
  generalize for a webhook-subscription model (Decision #3) rather than building a third parallel
  delivery pipeline alongside the connector-outbound and notification-outbound ones that already
  exist.
- **`tenants.plan`** (`packages/db/src/schema/platform.ts`, `text("plan").default("standard")`)
  already exists and is the natural dimension for per-plan rate-limit tiers (Decision #5) — no new
  schema needed for that piece.
- **`admin_audit_log.actor_type`'s existing `CHECK` constraint** covers `user`/`api_key`/`system`
  only. `system` already means "no human/API-key actor — internal automated action" (confirmed:
  `entity-engine`'s engine.ts and `tenant-purge.ts` both set `actorType: "system"` for background/
  automated writes). **Reusing `system` for Tier 2's external-but-trusted callers would conflate
  two different meanings** — internal automation vs. an external company product acting with real
  delegated authority. This ADR would propose a new value instead, whenever Tier 2 is built — see
  the correction note above and Deferred Decisions; not part of this revision's Decision section.

---

## Decision (proposed)

1. **This ADR now covers Tier 1 only. Tier 2 (trusted in-house sibling products) is deferred —
   see Deferred Decisions.** rev.1's justification for building Tier 2 now ("a real, named,
   near-term need per explicit product decision") didn't hold up when checked directly: no concrete
   day-one sibling product exists (confirmed 2026-08-05). That is exactly the condition ADR-008
   used to defer `agent` ("no tracked requirement exists for it... returns nothing"). Building a
   new principal type, a `CHECK`-constraint migration, and a cross-tenant allowlist mechanism for a
   need with no named consumer would repeat the mistake ADR-008 avoided, not a different case. The
   two-tier _distinction_ itself is still correct and kept — Tier 1 and Tier 2 remain genuinely
   different trust relationships that would be wrong to conflate whenever Tier 2 is eventually
   built (see Context above) — only the "build Tier 2 now" decision is reversed.

2. **Tier 1 stays on the existing tenant-issued `api_key` mechanism (ADR-008), but not
   unchanged.** ADR-008 rev.4, Decision #6 commits to the `api_keys.scopes` re-shape
   (role-strings → connector/action-strings) as a Tier 1 prerequisite, precisely because Tier 1 is
   the "first real external API consumer... a partner integration" ADR-008 itself named as the
   trigger for that re-shape. Concretely: a Tier 1 partner key is scoped to specific actions (e.g.
   "create ticket in workflow X," "read records of entity type Y") rather than a role level like
   `agent`/`admin` that would hand the partner the same blanket access as a human staff member
   across the whole tenant. **OAuth2 authorization-code + consent, via Zitadel** (not a bespoke
   authorization server) is the decided upgrade path beyond the scoped `api_key` — a partner app
   registers as a Zitadel application under the relevant project, a tenant's user consents, OpenWind
   verifies the resulting JWT through the existing `jwks.ts` path with a claims-mapping addition for
   "this token represents partner app X, consented by user Y, for tenant Z." **Deferred**, not
   built now — see Deferred Decisions for the trigger.

3. **Webhook subscriptions: a new `event_subscriptions` table, generalizing ADR-009's outbound
   delivery infrastructure rather than building a third pipeline.** A Tier 1 caller registers a URL
   and an event-type filter (e.g. `workflow.transitioned`, `entity.created`) and receives a stream
   of matching platform events — distinct from the automation engine's existing single-rule/
   single-URL `webhook` action, and distinct from ADR-009's connector-specific outbound delivery.
   Reuses: the dedicated-queue pattern (its own BullMQ queue, not `outbox_events`, for the same
   reason ADR-009 rejected the shared allowlist), HMAC-SHA256 signing over `timestamp + body`, a
   versioned envelope (`version` field, per `architecture-brief.md` §6.2), per-attempt SSRF
   validation via the existing `validateWebhookUrl()`, a delivery-attempt record (not just a
   terminal status), and the non-destructive per-installation kill switch pattern.
   **Tenant isolation is an explicit decision, not an inference: subscriptions are scoped to
   events within the registering caller's own tenant only** — enforced by tenant-scoped RLS on the
   subscription row, same mechanism as `connector_credentials`, not merely implied by that RLS
   existing. Cross-tenant event visibility for a partner is out of scope for v1 (see Deferred
   Decisions) — the default, absent an explicit grant, is always same-tenant-only. Designed to
   extend cleanly to Tier 2 callers once Tier 2 itself is built — this table's shape doesn't need
   to change for that, only who's allowed to register a subscription.

4. **Public API versioning is decided now, before Tier 1 has a live external consumer.**
   URL-path versioning (`/v1/...`) for any endpoint intended for Tier 1 consumption — the same
   "decide while it's free" principle ADR-009 applied to `connector-sdk`'s types. Internal-only
   endpoints (admin-ui, worker-internal) are unaffected; this applies only to the surface Tier 1
   actually calls.

5. **Rate limiting: per-plan tiers, not a new fail-mode.** Reuses the existing key-agnostic
   `checkRateLimit()` (`packages/redis/src/rate-limit.ts`) with a key that includes `tenants.plan`
   as a dimension (e.g. `rl:plan:${plan}:${tenantId}`) — no new fail-open/fail-closed code path.
   This deliberately avoids the mistake found in ADR-009's first two revisions, where a new
   fail-closed tier was proposed before any real traffic existed to justify it.

6. **No aggregate cap across the platform's outbound-delivery mechanisms is set by this ADR —
   flagged, not resolved.** After ADR-009 and this ADR, a single tenant event can fan out through
   the automation engine's existing single-rule webhook action, ADR-009's connector-outbound queue,
   _and_ this ADR's `event_subscriptions` — three independent mechanisms with no combined-load
   consideration or per-tenant limit on total connectors + subscriptions. Not a known problem today
   (no live traffic on any of the three), but worth a stated assumption rather than silent
   composition risk. See OQ-5.

7. **Developer experience (OpenAPI spec, public docs, SDKs) is Important, not Core, for this
   ADR's scope — deferred with a named trigger**, not built speculatively. See Deferred Decisions.

---

## Consequences

### Positive

- Deferring Tier 2 until a concrete sibling product exists avoids building a principal type, a
  `CHECK`-constraint migration, and a cross-tenant allowlist mechanism for a requirement that isn't
  named yet — the exact trap ADR-008 avoided for `agent`, now avoided here too instead of repeated.
  The Tier 1/Tier 2 _distinction_ survives for whenever Tier 2 is actually built.
- Pulling ADR-008's scopes re-shape forward means Tier 1 partners get action-scoped keys from day
  one, never a role-scoped over-grant that would need retroactive tightening once a partner already
  depends on the coarse behavior.
- Reusing Zitadel for Tier 1's OAuth/consent path avoids building and securing a bespoke
  authorization server — a genuinely large, security-critical undertaking — when the existing IdP
  already does this and already models multi-tenant orgs the way OpenWind needs.
- Reusing ADR-009's outbound delivery infrastructure for webhook subscriptions (rather than a third
  pipeline) means signing, retry, versioning, and delivery-attempt recording are consistent across
  every outbound surface the platform has, instead of three different implementations to keep
  correct and secure independently.
- Versioning decided now, while the cost is zero (no live Tier 1 consumers yet), avoids the exact
  trap ADR-009 flagged for `connector-sdk`'s types — a breaking change that's free today and
  expensive after the first real external consumer exists.

### Negative and mitigations

- **This ADR now ships less than rev.1** — no Tier 2 principal type, no cross-tenant allowlist
  mechanism. If a sibling-product integration is actually closer than "no concrete product exists"
  suggests, deferring Tier 2 pushes that work to whenever it's picked back up, not now. Mitigation:
  the deferral has a named trigger (Deferred Decisions), not an indefinite postponement, and the
  two-tier architecture already accounts for Tier 2's shape so building it later isn't starting
  from zero.
- **`event_subscriptions` is new infrastructure**, not pure reuse — a new table, a new queue, and
  a decision about how broadly Tier 1 partners can subscribe (any tenant's events, or only their
  own tenant's) that isn't fully specified here.
- **Pulling this into Phase 3A adds scope to a phase that already covers ADR-009's connector
  runtime** — this was an explicit product trade-off (ship the inbound and outbound integration
  story together, reviewed once) rather than sequencing them across phases, accepted knowingly
  rather than discovered as scope creep later. Deferring Tier 2 (this revision) partially reverses
  that trade-off back toward a smaller Phase 3A footprint.
- **No aggregate cap across the three outbound-delivery mechanisms (Decision #6)** — flagged as a
  real gap, not resolved. See OQ-5.

---

## Deferred Decisions

| Deferred item                                                                                      | Trigger to revisit                                                                                   | Why deferred now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier 2 (`service` principal, `actor_type` migration, cross-tenant allowlist)                       | A concrete in-house sibling product with a named, near-term cross-tenant integration need            | rev.1's justification didn't hold up when checked directly — no day-one consumer exists, matching the exact condition ADR-008 used to defer `agent`. Building a security-relevant mechanism for a need with no named consumer is worse than not building it yet, same reasoning ADR-008 applied. **When the trigger fires:** rev.1 specified authentication (Zitadel machine-user + JWT-bearer) and authorization (named allowlist) but never a credential-lifecycle story for this principal — no rotation, revocation, or anomaly-monitoring equivalent to ADR-008's `api_key` work, despite Tier 2 potentially carrying _more_ blast radius per credential (cross-tenant/platform-level scope) than a single-tenant `api_key`. Whoever builds this must add that, not just port rev.1's auth mechanism as-is. |
| Tier 1 OAuth2 authorization-code/consent flow (via Zitadel)                                        | First real partner app that needs per-tenant-user consent rather than an admin-pasted static API key | The static, now action-scoped `api_key` model (ADR-008 Decision #6) covers the near-term need; building the Zitadel-side app registration and claims-mapping work before a real partner exists to test it against is premature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Developer portal, public OpenAPI docs, SDKs                                                        | First external partner integration actually in progress                                              | `docs/platform-vision.md` already scopes this at Phase 6 — pulling the API/webhook _architecture_ into 3A doesn't require pulling developer-experience tooling in with it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tier 1 subscribing to events outside their own tenant (cross-tenant event visibility for partners) | A concrete partner use case requiring it                                                             | No current requirement; default should stay tenant-scoped-only for Tier 1 unless a real case demands otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Aggregate cap on connectors + subscriptions per tenant (Decision #6)                               | Observed write-path latency impact, or a tenant approaching an unreasonable count of either          | No live traffic on any of the three outbound mechanisms yet to size a limit against — same reasoning ADR-009 applied to deferring its fail-closed rate-limit tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## Open Questions

_(OQ-1/OQ-2 from rev.1 — the day-one Tier 2 operations list and consumer identity — are retired,
not renumbered: they were blocking questions for a Decision that's now deferred. They'll need
re-asking whenever Tier 2's trigger fires, not answering now.)_

| ID   | Question                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-3 | **Resolved (2026-08-05):** Type-level filtering only for v1.                                            | Confirmed with the product decider — simpler schema, revisit if the known Tier 1 partner (or a future one) actually needs entity-type/field-level filtering once building against real usage.                                                                                                                                                                                                                                                                     |
| OQ-4 | **Resolved (2026-08-05):** filed as issue #344, linked to #16, scoped to Tier 1 (inbound) specifically. | #16 is scoped outbound-only per its own body (ADR-009's territory) — keeping this as its own linked issue avoids conflating two ADRs' scope under one tracker item.                                                                                                                                                                                                                                                                                               |
| OQ-5 | **Proposed default, not yet confirmed:** monitoring-and-react, no proactive cap for v1.                 | Consistent with ADR-009's own precedent for deferring its fail-closed rate-limit tier — no live traffic on any of the three outbound mechanisms yet to size a limit against. Revisit if real usage approaches a level worth capping. As of 2026-08-24: the concrete near-term gate is ADR-012/Phase C (issues #467–#470) — still pre-launch, no real partner traffic exists yet, so the original "no live traffic to size against" premise still holds unchanged. |

---

## Implementation next steps

1. Tracked as issue #344 (OQ-4, resolved) — linked to #16, same tracked status as ADR-009's
   outbound work.
2. Implement ADR-008's Decision #6 (`api_keys.scopes` re-shape) _before_ or _alongside_ Tier 1's
   first partner key — it's a stated prerequisite now, not independent follow-up work. Coordinate
   directly with whoever picks up ADR-008's implementation.
3. Sequence `event_subscriptions` after ADR-009's outbound delivery infrastructure exists (queue,
   signing, versioning, delivery-attempt record) — this ADR generalizes that work, it doesn't
   duplicate it, so it should land after, not in parallel with, ADR-009's implementation.
4. Add an isolation-test pass for `event_subscriptions` (new tenant-scoped table) per this repo's
   own `testing-conventions.md` mandate.
