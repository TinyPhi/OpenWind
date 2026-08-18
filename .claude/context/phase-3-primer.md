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

Full detail for everything below: `docs/sup-docs/week-log.md`'s 2026-08-09/2026-08-12 entries.

- [x] #143 both phases done (PR #372, #380, 2026-08-12) — outbox writes unconditionally per
      `triggeredBy`, dedup on `(ruleId, transitionEventId)` via advisory lock. Unblocked
      [#364](../../issues/364), [#378](../../issues/378), [#379](../../issues/379) (all done).
- [x] `packages/connector-sdk/src/types.ts` breaking changes per ADR-009 Decisions #3/#5 — done
      2026-08-09 (PR #359): dropped readable `credentials` off `ConnectorContext`, removed
      `TriggerDefinition.webhook.validateSignature`, added required `ConnectorDefinition.allowedHosts`.
- [x] ADR-009's four independent housekeeping items — done; all 4 resolved (see 2026-08-09
      week-log entry for detail).

### Stage 1 — ADR-008 core hardening (independent of connector runtime)

Full detail: `docs/sup-docs/week-log.md`'s 2026-08-09 "Phase 3A Stage 1" entry.

- [x] `api_keys.created_by` + audit-log entry on mint/delete (Decision #2) — done 2026-08-09,
      migration 0053.
- [x] `api_keys.expires_at` + rotation flow + soft-revoke (Decisions #3–4) — done 2026-08-09,
      migration 0053. **Deliberately NOT implemented** (still needs a human decision, not a
      build task): OQ-2/OQ-3's forced-migration windows for already-existing keys, and a
      hard-delete/GDPR-purge action.
- [x] Isolation tests for both — done 2026-08-09.
- [x] Doc-only: Decision #5's agent/delegation deferral gate recorded in
      `docs/sup-docs/roadmap-tracker.md`'s 3C row — done 2026-08-09.

### Stage 2 — ADR-009 connector runtime + ADR-008 Decision #6 (parallel-capable)

Filed as granular, PR-sized GitHub issues 2026-08-10 (previously only lived as checkboxes here —
see issue #16's pinned comment for why the umbrella issue itself is stale and these are the
trackable replacement).

Runtime track — full detail for all done items: `docs/sup-docs/week-log.md`'s 2026-08-12/13 entries.

- [x] `ConnectorContext` + OpenBao credential decrypt — done 2026-08-12. Concrete
      `ConnectorAuthConfig` discriminated union (`bearer`/`basic`/`apiKey`) replacing the prior
      placeholder; `callApi()` enforces `allowedHosts` + a ported SSRF guard before any
      credential decrypt (ADR-009 Decision #5 ordering). **Security review caught a CRITICAL
      DNS-rebinding gap** (SSRF check validated one IP, `fetch()` could re-resolve to another) —
      fixed by pinning the outbound connection via a custom `http(s).Agent` lookup callback;
      also added the port allowlist automation-engine's guard already has. [#362](../../issues/362)
- [x] Inbound webhook gateway (`POST /webhooks/:connectorId/:tenantId`) — done 2026-08-13.
      HMAC-signature auth (no JWT/API-key), shared signing convention with #365's outbound side,
      Redis replay-dedupe failing closed, identical-401 no-existence-oracle design. **Security
      review found 2 HIGH findings, both fixed pre-merge:** the HMAC construction didn't cover
      the delivery-id (replay-under-relabeled-id), and a timing side-channel via the OpenBao
      round-trip leaked tenant/connector existence. [#364](../../issues/364)
- [x] Outbound delivery: dedicated queue, HMAC signing (Decision #9), sensitivity
      taxonomy/redactor (Decision #10) — done 2026-08-12, migration 0057
      (`connector_delivery_attempts`). Signing scheme (`HMAC-SHA256` over
      `deliveryId.timestamp.rawBody`) is the one #364 reuses for inbound verification.
      **Deliberately NOT built:** Decision #10's per-connector cross-tenant grant mechanism
      (no schema for it yet — needs human design) and producer wiring into the queue (that's
      #366/#368/ADR-010's job). [#365](../../issues/365)
- [x] `connector_definitions` + `connector_credentials` tables — done 2026-08-12, migration 0056.
      `connector_credentials` turned out to already exist since Phase 1 as an incompatible
      placeholder (zero real rows anywhere) — reshaped in place via `ALTER` rather than adding a
      second table; see week-log for why that was safe. [#363](../../issues/363)
- [x] Polling scheduler (BullMQ repeatable job per connector per tenant) — done 2026-08-18,
      reconcile-tick design (no install API yet, so this is the only place a `connector-poll`
      repeatable job is created/removed). See week-log 2026-08-18 entry for the two correctness
      bugs `/review` caught and fixed pre-merge (BullMQ `job.id` never populated by
      `getRepeatableJobs()`; cursor-keyed dedup id colliding across cycles when a connector never
      advances its cursor). [#366](../../issues/366)
- [ ] Kill switch (non-destructive disable, not just install/uninstall). [#367](../../issues/367)
- [ ] Build email (SMTP/IMAP) + WhatsApp Business connectors _together with_ the runtime — the
      runtime's shape is sized for exactly these two, not for a five-connector launch.
      [#368](../../issues/368)
- [ ] Connector marketplace UI (browse/install/configure). [#369](../../issues/369)

Scopes track (can run in parallel with the runtime track, same stage):

- [x] `api_keys.scopes` dual-format discriminator (Decision #6) — done 2026-08-12, migration
      0055: `scopes_format text NOT NULL DEFAULT 'role'` (CHECK `IN ('role','action')`). Existing
      keys stay on legacy role-strings, unmigrated. Full detail: week-log 2026-08-12.
      **Deliberately NOT implemented:** `scope-ceiling.ts` still rejects any non-role-string
      scope — no key can be minted with `scopes_format='action'` through the real API yet, since
      that needs OQ-5's verb set resolved and #365's redactor to exist first (see below).
      [#370](../../issues/370)
- [ ] Resolve OQ-5's exact verb set jointly with whoever scopes ADR-010's Tier 1 rollout —
      confirmed shape is `entity:<entityType>:<verb>` (e.g. `entity:ticket:create`,
      `entity:ticket:read`); still open whether a `transition` verb is needed or `create`+`read`
      suffice. Tracked in [#370](../../issues/370).
- [ ] Reopen `scope-ceiling.ts`'s rejection of action-format scopes once OQ-5 is resolved, with a
      real privilege-ceiling rule for the new verb set (today's `ROLE_LEVEL` map has no meaning
      for `entity:<type>:<verb>` strings). **Same PR must also fix two forward-compatibility traps
      flagged in PR #373's review (both marked with inline `TODO` comments at the call sites):**
      `resolve_api_key_by_hash` (migration 0031/0047) doesn't return `scopes_format` and
      `AuthContext` has no format field, so a Stage 3 `requireScope()` would have to re-derive
      format from string shape — fix requires `DROP FUNCTION` + recreate (Postgres can't
      `CREATE OR REPLACE` a changed return type), so it must land in this PR, not a follow-up
      (`packages/auth/src/middleware.ts`'s `resolveApiKey`); and `rotate.ts`'s
      `scopeCeilingError(roles, original.scopes)` call, unchanged, would permanently 403 rotation
      of every action-format key the moment they can be minted.
- [ ] Wire scoped reads through ADR-009 Decision #10's redactor (once built) — a Tier-1 key
      scoped to `entity:ticket:read` must see the same redacted view an equivalent-role human
      would, never a raw dump.
- [x] Isolation tests for the scopes_format migration — done 2026-08-12, extended
      `api-key-auth.isolation.test.ts` (default 'role', explicit 'action' round-trips under RLS
      scoped to its own tenant, CHECK constraint rejects an out-of-enum value).

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
- [x] Flip `docs/sup-docs/roadmap-tracker.md`'s 3A row from 🔴 Not started as stages land — done;
      currently 🟡 ~30%, kept current there each session, not duplicated here or in `CLAUDE.md`
      (both of those went stale for this exact reason once before — see 2026-08-13 cleanup).

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
  connectors, connector DPA framework, field-mapping AI assist (ADR-009); OpenAPI/SDKs, aggregate
  cross-mechanism outbound cap (ADR-010).
- **Optional-tier: iPaaS bridge (Trigger.dev).** ADR-009 explicitly resolved this as Optional
  (lower priority than the Important items above), not Important as issue #16's body groups it —
  the two source documents disagreed; ADR-009 sided with `docs/roadmap.md`'s classification.
  Solves a different problem (long-running/human-in-the-loop orchestration) than the connector
  marketplace ADR-009 covers — not folded in or dropped, just out of scope until picked up.

## Open confirmations still needed before specific PRs (not primer-blocking)

- OQ-2 / OQ-3 exact grace/rotation windows (Stage 1) — needs sign-off from whoever owns the
  resulting support/breakage burden.
- OQ-5 exact verb set (Stage 2 scopes track) — confirm at implementation time with ADR-010's
  Tier-1 rollout owner.
- Issue #143's resolution approach (Stage 0) — blocks ADR-009 Decision #3.
