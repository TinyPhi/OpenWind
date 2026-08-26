# ADR-015: Observability + Compliance (3D)

**Status:** Accepted.  
**Date:** 2026-08-26.  
**Deciders:** Abhinav Mishra.  
**Related to:** ADR-008 (API-key lifecycle — `api_keys.scopes_format` reused as the precedent for
config-driven tier/behavior discrimination), ADR-012 (third-party API rate-limit tiers — the
peer-middleware precedent for the billing gate below), ADR-013 (unified rate-limiting — already
named this ADR's `tenant_config.plan` billing gate as a placeholder seam, Decision #6/Deferred
Decisions), issue #19 (this ADR's source ticket), issue #6 (GDPR-per-user-erasure and
IP-allowlisting items this ADR absorbs — see Decision #4), issue #18 (3C, AI layer — the future
producer of the `ai_tokens` usage metric below, not yet started), issue #192 (backup/DR runbook —
scope boundary discussed in Deferred Decisions).  
**Supersedes:** —  
**Superseded by:** —

---

## Context

Issue #19 (filed 2026-05-14, no ADR since) scopes 3D as: OTel tracing, Prometheus metrics,
Sentry-style error tracking, Grafana dashboards, alerting, tenant usage metering, a billing/plan
enforcement gate, GDPR erasure (tenant + per-user), PII masking, data retention, IP allowlisting,
and backup/restore. Its 2026-08-19 review comment asked four things be settled before
implementation: self-hosted vs. SaaS for the observability backend, `tenant_usage` table shape,
reconciliation with issue #6's overlapping scope, and the billing/plan enforcement gate design.

What's already true in the codebase (confirmed by reading, not assumed) shapes every decision
below:

- **Correlation IDs already ship** (Phase 1, #7 — `apps/api/src/middleware/correlation-id.ts`).
  Out of scope here; issue #19 excludes it too.
- **No OTel/Prometheus/Sentry/Grafana dependency exists anywhere** in the workspace — this is
  greenfield, not a partial build-out.
- **No `tenant_config` table exists.** ADR-013 already confirmed this by the same grep. What does
  exist: `tenants.plan` (`text`, default `"standard"`) and `tenants.config` (`jsonb`, default
  `{}`) on `tenants` (`packages/db/src/schema/platform.ts`). New per-tenant settings this ADR
  needs (`retention_days`, `ip_allowlist`) have an existing home to extend, not a new table to
  invent.
- **Tenant-level GDPR deletion already ships**: `apps/worker/src/tenant-purge.ts` — a BullMQ job,
  default 30-day delay from `tenants.deletionScheduledAt`, FK-safe cascade delete, idempotent,
  audit log deliberately retained for compliance. A foundation to extend for per-user erasure, not
  something to build from scratch.
- **Append-only audit log already ships**: `@platform/audit` (`writeAuditEntry`/`queryAuditLog`),
  already used by `tenant-purge.ts`.
- **Rate-limiting has a real, working pattern to reuse**: `packages/redis/src/rate-limit.ts`
  (sliding-window sorted set, 250ms fail-open) plus ADR-013's tier precedence and
  `api_keys.scopes_format` discriminator.
- **`docker compose up -d` is the standard runtime** (CLAUDE.md) — every existing service
  (Postgres, PgBouncer, Redis, OpenBao, Zitadel, ClamAV, Novu behind `--profile notifications`) is
  containerized.

---

## Decision

1. **Metrics and tracing: self-hosted, added behind a new `docker-compose.yml`
   `--profile observability`** (same opt-in pattern as `--profile notifications` for Novu) —
   Prometheus + Grafana + Alertmanager, plus an OTel Collector for tracing. Ship
   `@opentelemetry/api` + auto-instrumentation for Hono/Drizzle/BullMQ now, with the trace
   exporter destination configurable via `@platform/config` rather than hardcoded, so a future
   SaaS APM is a config change, not a re-instrumentation. Rationale: metrics/traces carry no
   PII-leak surface (counters/histograms/spans, not payloads) and every other piece of this
   platform's infra is already self-hosted — a SaaS metrics vendor would add recurring cost for
   something Prometheus does natively and free, with no matching benefit.

2. **Error tracking: pluggable, not fixed to one vendor** — an `ERROR_TRACKING_PROVIDER` env var
   (`@platform/config`, typed, `"sentry" | "glitchtip" | "bugsink" | "none"`, **default `"none"`**)
   selects a DSN. This works because Sentry, GlitchTip, and Bugsink all speak the same ingestion
   protocol — the codebase only ever instruments against one SDK (`@sentry/node`); pluggability is
   a deployment/config decision, not an adapter-per-backend one.

   | Option             | Model               | Footprint                                                                | Notes                                                                                                                                           |
   | ------------------ | ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
   | Sentry SaaS        | Hosted              | Zero — just a DSN                                                        | Best default for installs with no data-residency constraint.                                                                                    |
   | Self-hosted Sentry | Self-hosted         | Heavy — 10+ containers (Kafka, ClickHouse, Snuba, Symbolicator, Relay)   | Viable for a large/regulated customer with the ops capacity for it.                                                                             |
   | GlitchTip          | Self-hosted         | Light — Django app + Postgres + Redis (infra this platform already runs) | Sentry-protocol-compatible, MIT licensed, mature. The proportionate self-hosted default.                                                        |
   | Bugsink            | Self-hosted         | Very light — single container, SQLite or Postgres                        | Newer, smallest-footprint option for a minimal/on-prem install.                                                                                 |
   | Highlight.io       | Self-hosted or SaaS | Heavy self-hosted (own ClickHouse-based stack)                           | Broader tool (session replay + traces + errors); **not** Sentry-protocol-compatible — the one option that would need its own SDK if ever added. |
   | None               | N/A                 | Zero                                                                     | Structured `@platform/logger` errors + Prometheus error-rate alerting (Decision #1). **The default** — see below.                               |

   `"none"` is an acceptable production default, not merely a dev fallback — error tracking is an
   operational nicety layered on top of Decision #1's metrics/alerting, not a functional
   dependency in the class of `DATABASE_URL`; requiring every self-hosted installation to stand up
   or pay for a provider before it can run in production would contradict the point of making
   this pluggable at all.

   Whichever backend is configured, its `beforeSend` (or equivalent) hook must apply the same PII
   scrubbing rules `@platform/logger` already applies before an event leaves the platform's infra
   boundary — this is a Decision #5 (PII masking) dependency shared across every provider, not
   specific to Sentry.

3. **`tenant_usage_daily` — a narrow `(tenant_id, date, metric) → value` table, not a wide
   per-metric-column row or raw per-event storage:**

   ```sql
   tenant_usage_daily (
     tenant_id UUID NOT NULL REFERENCES tenants(id),
     usage_date DATE NOT NULL,
     metric TEXT NOT NULL,        -- 'api_calls' | 'storage_bytes' | 'ai_tokens'
     value BIGINT NOT NULL,
     PRIMARY KEY (tenant_id, usage_date, metric)
   )
   ```

   A narrow `metric` column avoids a migration every time a new billable metric is added (webhook
   deliveries, connector invocations, as 3A/3C mature) — the trade is one extra `WHERE metric = ?`
   on a table that's read in aggregate, never on a request hot path. Raw per-event rows were
   considered and rejected: #19 explicitly says "aggregated daily," and per-event storage at
   platform scale is a retention/cost problem this table shouldn't inherit — finer-grained
   analysis is what Decision #1's tracing/metrics are for.
   - **Aggregation**: increment via Redis counters on the request path (same fail-open, low-
     latency pattern as `rate-limit.ts`), flushed to `tenant_usage_daily` by a scheduled job —
     mirrors the SLA-timer/outbox-poller pattern already in `apps/worker`.
   - **Storage bytes**: a daily job summing current `@platform/files` usage, not an incremental
     per-upload counter — storage isn't monotonic (deletes reduce it).
   - **AI tokens**: no producer exists yet (3C/issue #18 hasn't started). The column is
     schema-ready from day one but reads zero until 3C ships something that calls `packages/ai` —
     this ADR's work is not blocked on 3C.
   - **Retention**: reuses the same `retention_days`-per-tenant pattern issue #19 already names
     for workflow event/outbox archival, via the same `pg_cron` job class.
   - Standard tenant-scoped table otherwise: `tenant_id NOT NULL`, RLS policy, `tenant_id` index,
     composite `(tenant_id, usage_date)` index, analytics annotation, isolation tests — per
     `db-conventions.md`, no special-casing.

4. **Scope reconciliation with issue #6**: this ADR addresses the **GDPR-per-user-erasure** and
   **IP-allowlisting** items from #6 — not the SRI-hashes item, which #6 itself already marks
   reconciled/shipped via 3B (PR #397). Issue #19's Constraints section ("Addresses #6 (GDPR
   per-user erasure, SRI hashes)") should be corrected to drop the stale SRI reference once this
   ADR is accepted.
   - **GDPR per-user erasure** extends `tenant-purge.ts`'s pattern (FK-safe, idempotent,
     audit-log-preserving) rather than inventing a second deletion architecture. The difference in
     scope: one user's rows across every table with a user reference (`created_by`, `assigned_to`,
     etc.), not every row for a tenant — requires enumerating those FKs, which `tenant-purge.ts`
     doesn't currently need to do since it deletes by `tenant_id`.
   - **IP allowlisting** (`ip_allowlist[]`) becomes a field on the existing `tenants.config` jsonb
     (or a typed column if the auth-middleware query pattern needs indexing), not new
     infrastructure, per Decision #3's table-shape reasoning about not inventing a `tenant_config`
     table.
   - Explicitly **not** this ADR's scope (correctly excluded from #6): DR/backup strategy (#192,
     partially shipped — see Deferred Decisions), Redis SPOF (Phase 2 infra, unrelated), data
     residency (Phase 3 enterprise-tier planning — a bigger question than this ADR should absorb).

5. **Billing/plan enforcement: a new Hono middleware, peer to (not merged into) the rate-limit
   middleware, that degrades rather than blocks — with the degraded state made visible to the
   user, not silent.**

   Kept separate from `packages/redis/src/rate-limit.ts` because the two check different things:
   rate limiting is a time-windowed request-rate concern; billing enforcement is a usage-total
   concern against `tenant_usage_daily` (Decision #3) — different checks that happen to both end
   in a non-`200`, composed the same way every route already composes middleware
   (`factory.createHandlers`).
   - **Degrade, don't hard-block.** Exceeding a plan limit does not fail the request. Degraded
     state is per-metric (`{ api_calls, storage, ai_tokens }` independently), computed cheaply from
     the same narrow `tenant_usage_daily` rows:
     - API calls over cap → non-essential background work backs off for that tenant (automation
       rule execution, webhook delivery retries use a longer backoff) — the tenant keeps working;
       what's throttled is the platform's actual cost exposure.
     - Storage over cap → new uploads blocked (a real necessary limit), reads/existing data
       unaffected.
     - AI tokens over cap (once 3C exists) → AI-powered actions queue or fall back to a non-AI
       path rather than degrading the whole tenant.
   - **Visible signal, reusing the pattern this platform already shipped**: the API adds a
     lightweight response header on every request for a degraded tenant (`X-Tenant-Degraded:
api_calls,storage`, empty/absent when not degraded) — no new polling endpoint, any existing
     API call already carries it, same idea as the correlation-ID header. `apps/admin-ui/src/
components/global-error-banner.tsx` (shipped via `feat/PLAT-403-network-status-awareness`)
     gets a new `degraded` banner kind alongside `offline`/`reconnecting`/`recovered`: low-key,
     `role="status" aria-live="polite"`, dismissible (unlike the network-status banners — this
     isn't an outage, the user can keep working), reappearing on the next degraded response if
     dismissed and still degraded, with a link to a usage page. A new `network.planDegraded`-style
     i18n key follows the existing `network.*` convention.
   - **Also notify, not just show a passive banner.** The same daily usage-flush job (Decision #3)
     that computes the per-metric degraded state publishes a `tenant.plan_degraded` event (the
     platform's existing `dot.notation` event-type convention) to the tenant's admin role via the
     already-wired Novu pipeline (2A) **on transition into degraded state**, not per-request —
     firing per-request would be spammy and redundant with the always-visible banner. A symmetric
     `tenant.plan_recovered` event fires on exit, so admins aren't left wondering whether the
     degradation is still active.
   - **Plan limits**: read from `tenants.plan` (existing column) against a small static
     per-plan-limit config (`@platform/config`) — not a new table — unless/until a concrete need
     for admin-editable per-tenant overrides exists (e.g. a negotiated enterprise deal), at which
     point it's a `tenants.config` jsonb override checked before the plan default, not a parallel
     table.
   - **Fail-open on infra flakiness**, matching rate-limiting's own philosophy: a Redis/DB hiccup
     computing usage should not itself degrade every tenant — log and treat as not-degraded on
     check failure.

6. **Suggested staged sequence** (adjustable — not binding beyond ordering dependencies):
   1. **Stage 0 — Foundations**: OTel + Prometheus `/metrics` + `--profile observability`
      (Decision #1). No PII/GDPR work yet.
   2. **Stage 1 — Error tracking + PII masking**: pluggable SDK wiring (Decision #2), `beforeSend`
      scrubbing reconciled against `@platform/logger`, `workflow_events.metadata` PII audit.
   3. **Stage 2 — Usage metering + billing gate**: `tenant_usage_daily` (Decision #3), Redis
      counter + flush job, the degrade-and-notify middleware (Decision #5).
   4. **Stage 3 — Compliance**: per-user GDPR erasure, IP allowlisting (Decision #4),
      `retention_days` archival jobs.
   5. **Stage 4 — Dashboards + alerting**: Grafana dashboards, Alertmanager rules — deliberately
      last, since they need Stage 0–2's metrics to already exist to be meaningful.

---

## Consequences

### Positive

- Every infra choice (Decision #1, #2) fits the platform's existing "everything containerized,
  opt-in profile" convention — no bespoke deployment story for 3D.
- Error tracking has zero forced vendor lock-in and zero forced cost for installations that don't
  want it, while still giving installations that do want self-hosted a proportionate option
  (GlitchTip/Bugsink) instead of only the heavyweight full-Sentry choice.
- The billing gate reuses `tenant_usage_daily`'s per-metric shape for both enforcement and user
  communication (banner + notification), instead of building degraded-state detection twice.
- GDPR per-user erasure and IP allowlisting both extend existing mechanisms
  (`tenant-purge.ts`, `tenants.config`) rather than introducing new architecture.
- `ai_tokens` is schema-ready without blocking on or being blocked by 3C.

### Negative and mitigations

- **`"none"` as the error-tracking default means an installation can run in production blind to
  unhandled exceptions** unless it explicitly configures a provider. Mitigation: Stage 0's
  Prometheus error-rate metric and alerting rules are the backstop that doesn't depend on this
  choice — an installation running with `ERROR_TRACKING_PROVIDER=none` still gets alerted on
  elevated error rates, just without individual-exception detail/grouping.
- **Pluggable error tracking still couples the codebase to Sentry's protocol/SDK** — Highlight.io
  or any future non-compatible tool isn't a free config change. Mitigation: this is a deliberate,
  named trade-off (see Decision #2's table), not an oversight; revisit only if a concrete
  installation needs a protocol-incompatible tool.
- **The degrade-and-notify design adds a new middleware, a new event type, and a new banner class
  to maintain** on top of everything Stage 2/Stage 5 already introduces. Mitigation: it
  deliberately reuses three already-existing mechanisms (`global-error-banner.tsx`, the Novu
  pipeline, the correlation-ID-style response-header pattern) rather than inventing new ones, to
  keep the net-new surface to the middleware and event-publish logic themselves.
- **Backup/restore** is named in #19 but overlaps #192 (already has a mechanical piece shipped,
  PR #286) — see Deferred Decisions; this ADR doesn't resolve which track owns the remainder.

---

## Deferred Decisions

| Deferred Item                                                                                                                | Trigger to Revisit                                | Why Deferred Now                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Highlight.io (or any protocol-incompatible error/observability tool) as a first-class pluggable option                       | A concrete installation requests it               | Would require its own SDK integration, not just a DSN/config change like the Sentry-protocol options — disproportionate to build speculatively.                                       |
| Admin-editable per-tenant plan-limit overrides (beyond the static per-plan config)                                           | A negotiated enterprise deal actually needs one   | No concrete need yet; `tenants.config` jsonb is the identified seam if/when one arises.                                                                                               |
| Backup/restore (per-tenant logical dump, enterprise tier) ownership — stays under #192, or folds into this track's Stage 3/4 | Whenever #192's remaining scope is next picked up | #192 already has a mechanical piece shipped (PR #286); building this twice under two issues would be wasteful, but resolving which owns it is a scoping call, not an engineering one. |
| Data residency / regional Postgres clusters                                                                                  | Phase 3 enterprise-tier planning                  | Explicitly named in #6 as out of scope for this ADR — a bigger architectural question.                                                                                                |

---

## Open Questions

None

---

## Implementation next steps

1. Once accepted, update issue #19's Constraints section to drop the stale SRI cross-reference
   (Decision #4) and link this ADR.
2. Follow the Stage 0–4 sequence in Decision #6, each stage through the normal
   Plan → Code → Review → Docs → Ship guardrail flow (`agent-behaviour.md`), starting with a
   `/spec` for Stage 0.
