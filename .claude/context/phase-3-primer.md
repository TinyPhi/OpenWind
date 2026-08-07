# Phase 3A Primer — Integration Layer (ADR-008 / ADR-009 / ADR-010)

Load this file before any Phase 3A work (connector runtime, webhook gateway, inbound partner
API, or anything touching `packages/connector-sdk`, `api_keys`, or new `connector_*` /
`event_subscriptions` tables). Written per `CLAUDE.md`'s standing instruction to produce this
primer before 3A starts, and per each of ADR-008/009/010's own "Next steps if accepted" —
all three independently asked for it.

**Status as of 2026-08-06:** all three ADRs accepted and moved from `docs/specs/` to
`docs/decisions/`. Planning is done; nothing below is blocked on ADR acceptance anymore —
implementation can start at Stage 0.

| ADR     | Location                                                                   | Title                                                        | Scope                                                                                                                                   |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-008 | `docs/decisions/ADR-008-api-key-credential-lifecycle-hardening.md`         | API Key & Credential Lifecycle Hardening                     | Harden the existing `api_key` principal (audit-on-mint, expiry, rotation, soft-revoke, scopes re-shape). Agent principal type deferred. |
| ADR-009 | `docs/decisions/ADR-009-connector-runtime-webhook-gateway-architecture.md` | Connector Runtime & Webhook Gateway Architecture             | In-house connector runtime, inbound webhook gateway, outbound delivery, email + WhatsApp v1 connectors.                                 |
| ADR-010 | `docs/decisions/ADR-010-inbound-partner-api-integration.md`                | Inbound Partner API & Trusted Service-to-Service Integration | Tier 1 (arms-length partners) only. Tier 2 (in-house sibling products) deferred to a named trigger.                                     |

Tracked issues: [#16](../../issues/16) (3A umbrella), [#143](../../issues/143) (outbox gap,
blocks ADR-009 Decision #3), [#344](../../issues/344) (ADR-010/inbound, Tier 1 scope).

---

## Why build order is 008 → 009 → 010, not parallel

The three drafts cross-reference each other's decisions directly, not just topically:

- **ADR-008 Decision #1**: connector-initiated calls (ADR-009) authenticate via the existing
  `api_key` mechanism unchanged — no new principal type. ADR-009 is the near-term _consumer_ of
  ADR-008's identity model, but doesn't block on ADR-008's other decisions to start.
- **ADR-008 Decision #6 / ADR-010 Decision #2**: the `api_keys.scopes` re-shape (role-strings →
  `entity:<type>:<verb>` action-strings) is now a committed **Tier-1 prerequisite** for ADR-010,
  not independent follow-up. ADR-010's first partner key cannot ship on unchanged role-scopes —
  that would hand a partner blanket tenant access instead of scoped record access.
- **ADR-010 Decision #3 / Next step #4**: `event_subscriptions` generalizes ADR-009's outbound
  delivery infrastructure (queue, HMAC signing, versioning, delivery-attempt record) — it must
  land _after_ that infrastructure exists, not in parallel with it.
- **Shared component**: ADR-009 Decision #10 builds a `pii`/`financial` sensitivity
  taxonomy/redactor for connector-outbound payloads. ADR-008's OQ-5 (Tier-1 read-scope
  enforcement) and ADR-010's Tier-1 reads both reuse this _same_ redactor rather than inventing a
  second mechanism. Build it once, in ADR-009's work, before either of the other two need it.

Net: ADR-008's core hardening (Decisions #2–4) can start immediately and ships independently.
ADR-008 Decision #6 (scopes re-shape) and ADR-009's runtime can build in parallel once started,
but ADR-010 cannot ship its first partner key until both are done.

---

## Consolidated implementation sequence

Derived from all three drafts' own "Next steps if accepted" sections, merged into dependency
order. Each numbered item is a candidate `/spec` → `/spec-tasks` cycle / PR — do not try to
plan-lock all of this as one unit.

### Stage 0 — cheap prep, no ADR blocking

- [ ] Confirm issue #143's status and resolve it (or explicitly account for it) before
      implementing ADR-009 Decision #3 (webhook gateway reads the outbox) — automation-triggered
      transitions currently never reach the outbox, which would make connector webhooks silently
      miss them.
- [ ] `packages/connector-sdk/src/types.ts` breaking changes per ADR-009 Decisions #5/#6 — cheap
      now, more expensive the longer it waits, and blocks nothing else.
- [ ] ADR-009's four independent housekeeping items (see draft, "Independent housekeeping"
      section) — small, not gated on ADR acceptance.

### Stage 1 — ADR-008 core hardening (independent of connector runtime)

- [ ] PR: `api_keys.created_by` + audit-log entry on mint/delete (Decision #2).
- [ ] PR: `api_keys.expires_at` + rotation flow + `revoked_at`/`revoked_by` soft-revoke
      (Decisions #3–4). **Before shipping:** confirm exact grace/rotation windows with whoever
      owns partner/customer comms — OQ-2 (90-day grace, proposed) and OQ-3 (30-day forced
      rotation for legacy SHA-256-only keys, proposed) are defaults, not final.
- [ ] Isolation tests for both PRs (new columns/enforcement on a tenant-scoped table).
- [ ] Doc-only: record Decision #5's agent/delegation deferral gate in
      `docs/sup-docs/roadmap-tracker.md`'s 3C row, so it's visible when 3C planning actually
      starts (see "Deferred items" below — this primer also carries it).

### Stage 2 — ADR-009 connector runtime + ADR-008 Decision #6 (parallel-capable)

Runtime track:

- [ ] `ConnectorContext` + OpenBao credential decrypt (connector code never sees raw secrets).
- [ ] Inbound webhook gateway (`POST /webhooks/{connectorId}/{tenantId}`) — depends on Stage 0's
      #143 resolution.
- [ ] Outbound delivery: dedicated queue, HMAC signing, corrected retry semantics
      (Decision #9), sensitivity taxonomy/redactor (Decision #10 — **shared dependency**, see
      above).
- [ ] `connector_definitions` + `connector_credentials` tables, with isolation tests in the same
      PR that creates them.
- [ ] Polling scheduler (BullMQ repeatable job per connector per tenant).
- [ ] Kill switch (non-destructive disable, not just install/uninstall).
- [ ] Build email (SMTP/IMAP) + WhatsApp Business connectors _together with_ the runtime — the
      runtime's shape is sized for exactly these two, not for a five-connector launch.
- [ ] Connector marketplace UI (browse/install/configure).

Scopes track (can run in parallel with the runtime track, same stage):

- [ ] `api_keys.scopes` dual-format re-shape (Decision #6): pick a discriminator (recommend an
      explicit `scopes_format` column — `role` | `action` — over a colon heuristic or date
      cutoff, since it's the only option that doesn't break if a future role-string happens to
      contain a colon). Existing internal keys stay on legacy role-strings, unmigrated.
- [ ] Resolve OQ-5's exact verb set jointly with whoever scopes ADR-010's Tier 1 rollout —
      confirmed shape is `entity:<entityType>:<verb>` (e.g. `entity:ticket:create`,
      `entity:ticket:read`); still open whether a `transition` verb is needed or `create`+`read`
      suffice.
- [ ] Wire scoped reads through ADR-009 Decision #10's redactor (once built) — a Tier-1 key
      scoped to `entity:ticket:read` must see the same redacted view an equivalent-role human
      would, never a raw dump.
- [ ] Isolation tests for the scopes migration.

### Stage 3 — ADR-010 Tier 1 inbound partner API (after Stage 1 + Stage 2 land)

- [ ] Public API versioning scheme (decide before any live external consumer exists).
- [ ] `event_subscriptions` table generalizing ADR-009's outbound infra — isolation tests in the
      same PR.
- [ ] Rate limiting: per-plan tiers, reusing the existing key-agnostic limiter.
- [ ] First Tier-1 partner key issuance on the new action-string scopes.
- [ ] OpenAPI spec / public docs / SDKs — Important, not Core; can slip past initial launch.

### Stage 4 — close the loop

- [x] Update this primer's ADR references from `docs/specs/` to `docs/decisions/ADR-00N-*.md` —
      done 2026-08-06, all three accepted at their originally-proposed numbers.
- [ ] Flip `docs/sup-docs/roadmap-tracker.md`'s 3A row from 🔴 Not started as stages land.

---

## Deferred items (gates, not TODOs — re-evaluate only when the named trigger fires)

- **Agent principal type + delegation-chain audit schema (ADR-008 Decision #5).** Deferred to
  Phase 3C kickoff (issue #18). Re-evaluate against #18's _actual_ scope at that time: stays
  deferred if 3C is still human-in-the-loop config generation; becomes a prerequisite only if
  3C's scope expands to AI-initiated actions that commit without a human in the approval path —
  and if so, must be built to the full bar (sender-constrained tokens, RFC 8693-style delegation
  chain, real revoke-now), not incrementally.
- **Tier 2 service-to-service principals (ADR-010).** Deferred — no concrete day-one in-house
  sibling-product consumer exists. Re-evaluate only when one is named.
- **Important-not-Core items** (all decide-later-without-blocking-Core): Stripe/QuickBooks/Slack
  connectors, connector DPA framework, iPaaS bridge (Trigger.dev), field-mapping AI assist
  (ADR-009); OpenAPI/SDKs, aggregate cross-mechanism outbound cap (ADR-010).

## Open confirmations still needed before specific PRs (not primer-blocking)

- OQ-2 / OQ-3 exact grace/rotation windows (Stage 1) — needs sign-off from whoever owns the
  resulting support/breakage burden.
- OQ-5 exact verb set (Stage 2 scopes track) — confirm at implementation time with ADR-010's
  Tier-1 rollout owner.
- Issue #143's resolution approach (Stage 0) — blocks ADR-009 Decision #3.
