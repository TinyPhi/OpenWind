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

- [x] #143 both phases done — Phase 1 (producer side) merged via PR #372, 2026-08-12; Phase 2
      (consumer-side dedup, spec tasks T4/T6-T9) merged 2026-08-12. `executeTransition` writes to the
      outbox unconditionally for every `triggeredBy`, carrying a `transitionEventId`; `executor.ts`
      now serializes concurrent attempts at the same `(ruleId, transitionEventId)` pair on a Postgres
      advisory lock (auto-released on the enclosing real transaction's commit/rollback) and skips a
      rule whose actions already completed successfully for that pair, while still permitting retry
      of a `'failed'` attempt. T9 (unique-index backstop) was already covered by PR #372's own
      isolation test. **#364 (webhook gateway) is now fully unblocked**, including
      [#378](../../issues/378) (`outbox-poller.ts`'s temporary automation-transition exclusion,
      done 2026-08-12 — the poller now claims and enqueues these rows like any other, with a new
      isolation test proving the resulting race against the sync in-process path still nets to
      exactly one success) and [#379](../../issues/379) (the "transition" automation action now
      stamps `depth` onto its `executeTransition` call, done 2026-08-12, with a regression test).
- [x] `packages/connector-sdk/src/types.ts` breaking changes per ADR-009 Decisions #3/#5 — done
      2026-08-09 (zero consumers existed yet, so no migration needed): dropped the readable
      `credentials`/`TCredentials` field+generic from `ConnectorContext` (Decision #5),
      removed `TriggerDefinition.webhook.validateSignature` (verification centralizes in the
      gateway, Decision #3), and added a required `ConnectorDefinition.allowedHosts: string[]`
      egress allowlist (Decision #5), with a format comment (hostnames only, no scheme/path/
      wildcards). Decision #6 (first-party-only trust boundary for v1) needed no type change —
      it's a policy statement about who can author connectors, not a type-contract requirement;
      noted here so it isn't mistaken for a missed item (PR #359 review).
- [x] ADR-009's four independent housekeeping items (see draft, "Independent housekeeping"
      section) — 3 of 4 already resolved: #1 (issue #2 doc conflict) fixed by the stale-gate
      cleanup PR; #2 (Trigger.dev Important/Optional conflict) resolved — ADR-009 sided with
      `docs/roadmap.md`'s "Optional"; #3 (3D/3E lettering) resolved via a clarifying note in
      `docs/roadmap.md` treating `CLAUDE.md`/`roadmap-tracker.md` as authoritative. #4 is issue
      #143, tracked as its own item above — still open.

### Stage 1 — ADR-008 core hardening (independent of connector runtime)

- [x] PR: `api_keys.created_by` + audit-log entry on mint/delete (Decision #2) — done 2026-08-09,
      migration 0053.
- [x] PR: `api_keys.expires_at` + rotation flow + `revoked_at`/`revoked_by` soft-revoke
      (Decisions #3–4) — done 2026-08-09, migration 0053. New keys get a platform-configured
      default TTL (`API_KEY_DEFAULT_TTL_DAYS`, `packages/auth`) and `POST /api-keys/:id/rotate`
      mints a replacement while pulling the original's `expires_at` forward to a short overlap
      window instead of an immediate kill. **Deliberately NOT implemented:** OQ-2/OQ-3's
      forced-migration windows for _already-existing_ keys (90-day grace, 30-day legacy-SHA256
      deadline) — those still need sign-off from whoever owns partner/customer comms before any
      forcing mechanism is built; today's existing keys keep `expires_at = NULL` (immortal)
      exactly as before. Also not implemented: a hard-delete/GDPR-purge action — the ADR says
      this "can still exist" separately, not that it's required now.
- [x] Isolation tests for both PRs (new columns/enforcement on a tenant-scoped table) — done
      2026-08-09, extended `api-key-auth.isolation.test.ts` (revoked/expired keys stop
      authenticating) and `rls-followup-fixes.isolation.test.ts` (soft-revoke replaces the old
      hard-delete assertion).
- [x] Doc-only: record Decision #5's agent/delegation deferral gate in
      `docs/sup-docs/roadmap-tracker.md`'s 3C row, so it's visible when 3C planning actually
      starts (see "Deferred items" below — this primer also carries it) — done 2026-08-09.

### Stage 2 — ADR-009 connector runtime + ADR-008 Decision #6 (parallel-capable)

Filed as granular, PR-sized GitHub issues 2026-08-10 (previously only lived as checkboxes here —
see issue #16's pinned comment for why the umbrella issue itself is stale and these are the
trackable replacement).

Runtime track:

- [x] `ConnectorContext` + OpenBao credential decrypt (connector code never sees raw secrets) —
      done 2026-08-12. `ConnectorDefinition.auth` is now a concrete discriminated union
      (`ConnectorAuthConfig`: `bearer` / `basic` / `apiKey`, each naming the `credentialKey`(s)
      it needs) replacing the prior `Record<string, unknown>` placeholder — this is the exact
      shape #363's `connector_credentials` table needs to store (a JSONB map of
      `credentialKey -> ciphertext` per tenant-connector installation). `callApi()` enforces
      `allowedHosts` membership, then a ported, self-contained SSRF guard
      (`packages/connector-sdk/src/ssrf-guard.ts` — deliberately not importing
      `@platform/automation-engine`'s version, which would pull in `@platform/db`,
      `entity-engine`, `workflow-engine`, `bullmq`, `drizzle-orm`, `ioredis` as transitive deps
      for a lightweight SDK package), both strictly **before** any credential is decrypted —
      the exact ordering ADR-009 Decision #5 calls out to prevent `callApi()` being used as a
      credential-exfiltration oracle. `log()` delegates to `@platform/logger`'s existing pino
      `redact` config rather than reimplementing scrubbing. **PR review (PrabhuVijit) caught a
      CRITICAL DNS-rebinding gap in the first version:** the SSRF check validated a hostname's
      resolved IP but `callApi()` then used global `fetch()`, which re-resolves DNS independently
      — a 0-TTL DNS record could flip the address to something private between validation and
      the real connection. Fixed by pinning the outbound connection to the validated IP via a
      custom `http(s).Agent` `lookup` callback (`node:http(s).request`, not `fetch()` — Undici
      silently ignores the `agent` option), matching `automation-engine/src/actions/webhook.ts`'s
      already-established pattern exactly. Also added the port allowlist automation-engine's
      guard already has (host allowlisting alone doesn't stop reaching an arbitrary port on an
      allowed host). [#362](../../issues/362)
- [x] Inbound webhook gateway (`POST /webhooks/:connectorId/:tenantId`) — done 2026-08-13.
      Unauthenticated by JWT/API-key; the HMAC signature IS the authentication. Reuses
      `@platform/connector-sdk`'s outbound-envelope helpers built for #365's opposite
      direction (`verifyOutboundSignature`, `OUTBOUND_SIGNATURE_HEADER`/
      `OUTBOUND_DELIVERY_ID_HEADER`) rather than reimplementing HMAC verification or
      inventing different header names — resolves #365's own "pending reconciliation" note
      into one signing convention shared by both directions. Order of checks, all collapsed
      to an identical 401 for AC4's no-existence-oracle requirement (an attacker probing
      cannot distinguish "wrong tenant/connector" from "right one, wrong signature"): parse + range-check the `t=` timestamp (±5min tolerance, Stripe/Svix precedent), look up the
      installation's signing secret from `connector_credentials.secrets` (a new well-known
      `webhookSigningSecret` credentialKey, distinct from any outbound-API-auth key the same
      installation might carry), verify the signature against the raw body. Replay-dedupe on
      the delivery-id header is a Redis `SET NX EX` that fails **closed** (409 on replay, 503
      on a Redis error) — a deliberate divergence from `rate-limit.ts`'s fail-open
      `checkRateLimit` convention, since replay protection is a security control (a
      captured-and-resent valid request), not traffic shaping, and a sender's normal
      retry-on-no-response behavior means failing closed only delays processing, not loses
      it. AC5's `getConnectorDefinition()` reuse (from #365's in-memory registry) fails
      closed too (401) if the connector isn't registered — no real connector exists yet
      (#368's job); found no webhook trigger → 400; malformed JSON or a rejected transform →
      400 (a different failure class than AC4, since the caller already authenticated by
      that point). New `connectorInboundQueue` (`apps/worker/src/queues.ts`, mirrored in
      `apps/api/src/lib/connector-inbound-queue.ts` per the dependency rule) publishes the
      transformed event — no consumer exists yet, matching the issue's explicit scope (this
      is the producer/gateway side only). AC2's pre-auth IP-keyed flood guard is already
      satisfied by the existing global `rateLimit()` middleware (no redundant second guard
      added). **Security review found 2 HIGH findings, both fixed before merge:** (1) the
      shared HMAC construction (below) didn't cover the delivery-id, letting a captured valid
      delivery be replayed under a relabeled id — fixed in `outbound-envelope.ts` itself,
      coordinated with #365's PR; (2) a timing side-channel let an attacker distinguish
      "unknown tenant/connector" from "known, bad signature" by the presence of an OpenBao
      round-trip, defeating AC4 — fixed with a timing-equalizing dummy decrypt call. Both have
      regression tests. [#364](../../issues/364)
- [x] Outbound delivery: dedicated queue, HMAC signing, corrected retry semantics
      (Decision #9), sensitivity taxonomy/redactor (Decision #10) — done 2026-08-12, migration
      0057 (`connector_delivery_attempts`, RLS with both `USING`/`WITH CHECK` from day one).
      New `connectorOutboundQueue` (`apps/worker/src/queues.ts`): `attempts: 11`,
      `backoff: {type: "exponential", delay: 45_000}` — deliberately not
      `notifyOutboundQueue`'s 3-attempts/1s config (~7s window, sized for internal outages);
      worst-case cumulative delay `45_000 * (2^11 - 1)` ≈ 25.6h, approaching the ADR's
      Stripe/Svix ~27h reference. New pure module `packages/connector-sdk/src/
outbound-envelope.ts`: HMAC-SHA256 over `${deliveryId}.${timestampUnixSeconds}.${rawBody}`
      (deliveryId included in the signed content since a #364 security-review finding — see
      that entry above — an earlier version signed only `timestamp.rawBody`, which let a
      captured valid delivery be replayed under a relabeled delivery-id),
      `X-OpenWind-Signature: t=<unix>,v1=<hex>` + `X-OpenWind-Delivery-Id: <uuid>` headers
      (mirrors Stripe/Svix's `msgId.timestamp.payload` convention). #364 confirmed this scheme
      and reuses it directly (`verifyOutboundSignature`) for inbound verification — one
      signing convention shared by both directions, as intended. Also
      `validateActionOutput()` enforcing a new `ActionDefinition.maxOutputBytes` (default
      `DEFAULT_MAX_OUTPUT_BYTES = 256KB`) before schema validation (AC6). Decision #10's
      redactor is reused unchanged (`buildSensitivityMap`/`redactMetadata`), wired into the new
      `apps/worker/src/connector-outbound-worker.ts` queue consumer, which re-runs SSRF
      validation (`connector-sdk`'s `assertEgressAllowed`, from #362) and connection-pinning on
      **every** delivery attempt, not just the first. New `packages/connector-sdk/src/
registry.ts` (in-memory `Map`) is the seam letting the worker resolve a BullMQ job's
      `connectorId`/`actionId` back to its real `ActionDefinition` — a job's data crosses Redis
      as plain JSON and can't carry a live Zod schema. **Deliberately NOT built, per this
      issue's own scope:** ADR-009 Decision #10's "explicit per-connector grant to cross the
      tenant boundary" (redaction is always-on with no bypass mechanism — no column/table
      exists for a grant yet; a human needs to design one) and any producer wiring into the new
      queue (`enqueueConnectorDelivery()` is the integration seam; the actual trigger — polling
      scheduler #366, a built connector #368, or ADR-010's `event_subscriptions` — is separate,
      not-yet-built work). [#365](../../issues/365)
- [x] `connector_definitions` + `connector_credentials` tables — done 2026-08-12, migration 0056.
      `connector_definitions` is a genuinely new, platform-wide catalog table (no tenant_id/RLS,
      per ADR-001). **`connector_credentials` was NOT new** — discovered mid-implementation that
      it has existed since `0000_initial_schema.sql` (Phase 1), as a placeholder with an
      incompatible shape (`connector_id text` no FK, single `credentials text` blob) that #362's
      merged design didn't know about. Its only live consumer, `apps/worker/src/tenant-purge.ts`,
      only ever deletes by `tenant_id`, so reshaping it in place (rather than a second,
      differently-named table) was safe — confirmed zero real rows in any environment. Reshaped
      via `ALTER`: `connector_id` retyped to `uuid` + FK to `connector_definitions`, `credentials`
      replaced with `secrets jsonb` (credentialKey -> ciphertext map, matching #362's
      `ConnectorAuthConfig` exactly), added `cursor_state jsonb`, added `UNIQUE(tenant_id,
connector_id)`. RLS policies and the `app_user` grant (incl. DELETE, which `tenant-purge.ts`
      needs) were left untouched. Fixed #362's now-stale "doesn't exist yet" doc comment in
      `connector-sdk/src/runtime.ts`/`types.ts`. [#363](../../issues/363)
- [ ] Polling scheduler (BullMQ repeatable job per connector per tenant). [#366](../../issues/366)
- [ ] Kill switch (non-destructive disable, not just install/uninstall). [#367](../../issues/367)
- [ ] Build email (SMTP/IMAP) + WhatsApp Business connectors _together with_ the runtime — the
      runtime's shape is sized for exactly these two, not for a five-connector launch.
      [#368](../../issues/368)
- [ ] Connector marketplace UI (browse/install/configure). [#369](../../issues/369)

Scopes track (can run in parallel with the runtime track, same stage):

- [x] `api_keys.scopes` dual-format discriminator (Decision #6) — done 2026-08-12, migration
      0054: `scopes_format text NOT NULL DEFAULT 'role'` (CHECK `IN ('role','action')`), an
      explicit column rather than a colon heuristic or date cutoff, since it's the only option
      that doesn't break if a future role-string happens to contain a colon. Existing keys stay
      on legacy role-strings, unmigrated. `packages/auth/src/scopes.ts`'s `detectScopesFormat`
      recognises the confirmed `entity:<entityType>:<verb>` shape structurally, without
      hardcoding a verb enum — OQ-5 (below) is still open. `create.ts` stamps the column from
      the scopes actually supplied; `rotate.ts` carries the original's format forward unchanged.
      **Deliberately NOT implemented:** `scope-ceiling.ts` still rejects any non-role-string
      scope, so no key can actually be minted with `scopes_format='action'` through the real API
      yet — reopening that ceiling needs OQ-5's verb set resolved and #365's redactor to exist,
      so a Tier-1 key is never issued with no read-scoping enforcement behind it. No new
      `requireScope` middleware or issuance route either — that's Stage 3's job once a real
      consumer exists. [#370](../../issues/370)
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
