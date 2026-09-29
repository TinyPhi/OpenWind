# ADR-018: AI Layer (Phase 3C) — Assistive Generation Behind a Single Metered Gateway

**Status:** Draft for peer review (drafted 2026-09-28; accepting it does not start 3C — that remains a separate human scope decision).  
**Date:** 2026-09-28.  
**Deciders:** Engineering Lead (acceptance pending).  
**Related to:** ADR-004 (config-first module design — automation rules are data), ADR-006
(per-workflow ownership — `__accessUsers` guard gap), ADR-008 (API-key lifecycle — Decision #5,
agent/delegation identity gate), ADR-012 (third-party ticket API — Decision #5, human-approved
escalation), ADR-013 (unified rate limiting), ADR-015 (observability + compliance —
`tenant_usage_daily`, `ai_tokens` metric, plan degrade), ADR-017 (temporal scheduler — digest
substrate), issues #18 (3C tracker), #609, #614–618, #627–629.  
**Supersedes:** —  
**Superseded by:** —

---

## Context

### Problem — 3C has a reserved ADR number, a phased issue set, and no architecture

Issue #18 tracks the AI layer; its 2026-09-17 comment splits it into #614 (ADR + natural-language
automation rule generation), #615 (MCP-native governed action surface, exploratory), #616
(workflow suggestion), #617 (entity classification + RAG) and #618 (per-tenant AI usage metering,
"cross-cutting prerequisite"). #614's first scope bullet is "Write ADR-018 (AI layer) first". Three
more AI ideas are filed against 3C or adjacent tracks: #609 (3H AI-drafted weekly digest), #627
("why is this stuck?" instance explainer, bundled with #609), #628 (natural-language search, which
needs embeddings and a vector index) and #629 (workload-aware assignment suggestion).

These issues all restate the same constraints: a human reviews output before it has any effect
(#614, #616, #617, #609, #627), every call goes through `@platform/ai` (#18, #614, #609, #627), and
usage is metered per tenant before production (#18, #618). This ADR records them once, so any 3C
feature a human later starts inherits them instead of re-deriving them.

`docs/tracker/roadmap-tracker.md` (3C row) and `CLAUDE.md` (Current Focus) both record 3C as not
started and a human scope call. **Accepting this ADR does not start 3C and authorises no feature
work.** It fixes the shape any future 3C work must take.

### What already exists that this ADR builds on

- `packages/ai` is a stub: `src/client.ts` exports `createClient()`, which returns a provider SDK
  client (`@anthropic-ai/sdk` ^0.104.2, `packages/ai/package.json`) built from
  `env.ANTHROPIC_API_KEY`. No package or app depends on `@platform/ai` today; a repo grep for
  `@platform/ai` and `@anthropic-ai/sdk` outside `packages/ai` finds nothing. The only AI setting
  is `ANTHROPIC_API_KEY: z.string()`, required, at `packages/config/src/env.ts:179` (being made
  optional separately; see Resolved open questions, former OQ-8).
- Automation rules are rows validated at the API boundary by a discriminated-union Zod schema,
  `ActionConfigSchema` in `apps/api/src/routes/automation-rules/schemas.ts:112`, with trigger types
  in `TRIGGER_TYPES`. The same file notes that seed SQL bypasses this validation. Rules carry
  `is_enabled` defaulting to `true` (`packages/db/src/schema/automation-engine.ts:18`). Rules and
  workflow definitions are rows, never TypeScript (ADR-004 Decisions 3–4).
- Sensitivity taxonomy on `EntityField` (`packages/entity-engine/src/types.ts:32`) with
  `redactFields`/`buildSensitivityMap` (`packages/entity-engine/src/redact.ts`) and
  `redactMetadata`/`buildSensitivityMap` (`packages/workflow-engine/src/redact.ts`). These redact
  `pii`/`financial` only and deliberately keep `internal` (see the header comment in
  `packages/entity-engine/src/redact.ts`). `scrubPIIInPlace` in `packages/telemetry/src/errors.ts`
  scrubs error-tracking payloads (ADR-015 Decision #2).
- ADR-015 Decision #3: `tenant_usage_daily` (`packages/db/src/schema/platform.ts:642`) already has
  an `ai_tokens` metric slot with "no producer exists yet". ADR-015 Decision #5 says an AI-token
  cap should make "AI-powered actions queue or fall back to a non-AI path", with plan limits read
  from `tenants.plan` (`packages/db/src/schema/platform.ts:23`) and overrides in `tenants.config`.
- ADR-013 Decisions 1–3: one sliding-window primitive (`packages/redis/src/rate-limit.ts`), a
  3-tier shape, and tightest-tier-wins. That primitive fails open on Redis errors
  (`rate-limit.ts:48–51`).
- ADR-008 Decision #5: the agent principal type and delegation-chain audit are deferred to "Phase
  3C kickoff (issue #18)"; they become a prerequisite only if an AI-initiated action commits without
  a human, built to ADR-008's bar (sender-constrained tokens, derived delegation, revoke-now).
  ADR-008 notes a human-saved AI proposal is already attributed via `actor_type='user'` plus a
  `metadata.ai_generated: true` flag.
- ADR-012 Decision #5: privilege escalation is always human-approved. `admin_audit_log`
  (`packages/db/src/schema/platform.ts:310`) is append-only and tenant-scoped.

---

## Decision

### Decision 1 — AI is assistive only: it drafts, a human commits

Every 3C feature produces one of four outputs: a **draft** (automation rule, workflow
states/transitions, reply), a **suggestion** (assignee, classification), a **summary** (digest,
explainer) or a **search result**. None of them changes tenant state by itself. A state change
happens only when a human performs the same action they could perform without AI, through the same
route, role check and validation (#614, #616, #617, #609, #627).

- **Generated artefacts are data, never code.** A generated automation rule is a candidate
  `automation_rules` row. It must parse against the existing `ActionConfigSchema`/`TRIGGER_TYPES`
  and is saved only through the existing automation-rules create route, so admin role checks and
  validation apply unchanged (ADR-004 Decisions 3 and 6). A generated workflow is a candidate set
  of `workflow_states`/`workflow_transitions` rows, opened for editing in the existing workflow
  editor (#616). If the model's output fails validation, the user sees the validation error. The
  output is never coerced or partially saved.
- **No new execution primitive.** AI output never adds an action type, trigger type or script. If
  a request can't be expressed with existing primitives, the answer is ADR-004 Decision 6: an
  engine PR with its own review, not a generated escape hatch.
- **Draft rules land inactive.** A generated rule is either unsaved until the human clicks save, or
  saved with `is_enabled = false`. It is never saved under the column's `true` default (#614
  acceptance: "No generated rule activates without explicit human save").
- **Attribution.** The committing human is the actor (`actor_type='user'`). The audit row carries
  `metadata.ai_generated: true` plus the feature id (ADR-008 rationale point 1). No system or agent
  principal is introduced.
- **Outward effects need explicit acknowledgement.** Some generated rules contain actions that
  reach outside the tenant (`webhook`, `connector.action`) or change state (`transition`,
  `set_field`, `assign`). The review surface must show these actions explicitly before save. This
  is the same "human approves" boundary as ADR-012 Decision #5.

### Decision 2 — One gateway: every model call goes through `packages/ai`

`packages/ai` becomes the only place a provider SDK is imported. Its public API takes a typed
request carrying `tenantId`, `featureId` (a closed enum, one value per shipped feature), `actorId`
and the minimised context from Decision 4. It returns a typed result carrying output, provenance
and usage. In order, the gateway checks budget and rate limit (Decision 3), asserts the payload
came from the Decision 4 projection, calls the provider with feature-configured parameters
(Decision 7), records tokens and estimated cost against `tenantId` + `featureId`, and logs metadata
without prompt or output bodies.

No app, worker or module imports `@anthropic-ai/sdk` (or any future provider SDK) directly. #18
already states this for modules ("never call Anthropic API directly from modules"). This ADR widens
it to `apps/*`, to be enforced the same way the dependency rule is (ESLint `no-restricted-imports`
plus `pnpm dep:check`). The bare `createClient()` export is removed or made internal when the first
feature lands. Otherwise it is an ungoverned bypass.

Considered alternative: let each feature call the SDK and share helpers. Rejected. Metering,
redaction and rate limiting then depend on every call site remembering them, and #618's acceptance
("No AI feature … reaches production without this in place first") can't be checked structurally.

### Decision 3 — Metering and per-tenant/per-feature limits land before or with the first AI feature

Per #18 and #618, metering is a gate, not follow-up work. The first AI feature to reach production,
whichever of #609/#614/#627 a human picks, ships in the same change set as:

- **Usage recording.** Each gateway call increments the existing `ai_tokens` metric in
  `tenant_usage_daily` through the Redis-counter-plus-flush path ADR-015 Decision #3 describes.
  Estimated cost and per-feature attribution are also recorded; storage shape is OQ-2.
- **Request-rate limiting.** The call uses ADR-013's sliding-window primitive with its tier shape:
  per (user, feature), then per tenant, tightest wins (ADR-013 Decisions 1 and 3), with defaults
  from `@platform/config` and a `tenants.config` override seam (ADR-013 Decision 6).
- **Plan-cap degrade.** ADR-015 Decision #5's `ai_tokens` degrade applies. Over cap, AI
  affordances are hidden or queued and the non-AI path (manual rule editor, plain list view) keeps
  working.

Why before and not after: #609 and #627 both require per-tenant logging "from day one". Cost from
model calls grows with prompt size, which a tenant controls indirectly through record volume, so
spend isn't bounded by request rate alone. And ADR-015's daily flush means the plan cap is enforced
with up to a day's lag, which only works if a short-window rate limit is already in place.

### Decision 4 — Data minimisation and tenant isolation are properties of context building

- **Only readable records, only in the tenant.** Context for a call is loaded through the same
  engine read paths, under the same RLS session and tenant filter, as the acting user's own API
  reads (ADR-001). No feature uses a privileged or cross-tenant query to build a prompt. There is
  no cross-tenant retrieval, few-shot pool or shared cache keyed on content. Record-level read
  access, including `__accessUsers` grants, uses the same checks as the entity read routes (see
  Resolved open questions, former OQ-4).
- **Projection, not redaction.** Following #609, each feature defines an explicit per-feature
  projection. By default it includes only `public`-sensitivity fields plus structural facts (entity
  type, state label, time in state, counts) and excludes comments and free text. It reads
  `EntityField.sensitivity` directly (the existing `buildSensitivityMap` records only
  `pii`/`financial`, so it can't express an allowlist) and drops, rather than `[REDACTED]`-tokens,
  anything outside the allowlist. The existing redactors keep `internal` fields on purpose because the
  readers are tenant admins. That policy is not the right default for data leaving the platform
  boundary, so the projection is stricter than `redactFields`. Each feature ships a test asserting
  a `pii`-tagged value never appears in the constructed prompt (#609 acceptance).
- **Retention.** The platform doesn't persist prompt or output bodies by default. Logs and audit
  rows store metadata only: tenant, feature, actor, record ids, token counts, model config id and
  outcome (accepted, edited, discarded). Any body retention is opt-in and follows ADR-015's
  `retention_days` pattern (OQ-5).
- **No training on tenant data.** The configured provider account's terms must exclude training on
  submitted data. This is a provider-configuration requirement that this draft doesn't verify for
  any provider (OQ-6). The platform does no fine-tuning on tenant data.
- **Error paths.** Provider errors are logged through `@platform/logger`/`@platform/telemetry`,
  whose scrubbing (`scrubPIIInPlace`) applies. Prompt bodies are never attached to error events.

### Decision 5 — Outputs carry provenance and disclose what they could not assess

Per #609's trust requirement, a summary that says "all on track" while something is stalled is
worse than no summary. Every AI result from the gateway therefore carries:

- **Provenance:** the record ids (and, for search, the matching fields) the output was derived from,
  so the UI can link each claim back to its source records.
- **Coverage:** counts of records considered and records the model couldn't assess (missing data,
  ambiguous state, conflicting signals), shown to the user ("2 items couldn't be assessed — click to
  review", #609). Those records are never silently left out.
- **Disclosure:** AI-generated content is labelled wherever a user sees it (#609, #617).
- **Checked references:** config features (#614, #616) validate structured output with Zod.
  Free-text features (#609, #627) fail the generation if it cites an id not in the supplied context.

Numeric "confidence" scores from a model aren't treated as calibrated. Coverage is computed
deterministically where it can be (e.g. an instance with no transitions in N days is counted
whatever the model says). Whether to show a model-reported confidence at all is OQ-3.

### Decision 6 — Sequencing: cheap, read-only, stateless features first; bigger surfaces behind their own decisions

When a human starts 3C, the order is:

1. **First slice**, stateless calls with no new infrastructure: summarisation (#609 digest, which
   reuses the ADR-017 scheduler and existing notifications, bundled with #627) and/or #614 NL →
   draft automation rule. Each ships with Decision 3's metering in the same change set.
2. **#616** workflow suggestion, after #614 (per #616), reusing the same draft-and-review boundary.
3. **#629** assignment suggestion, only once a multi-assignee workflow exists (#629 depends on
   #610). The suggestion is shown with its stated reason and the admin can override it.
4. **Deferred behind their own decisions:** embeddings and a vector index (#617 RAG, #628 search)
   need a separate decision covering index choice, per-tenant partitioning and RLS on vector rows,
   refresh and staleness, and erasure propagation (ADR-015 Decision #4). #615, the MCP action
   surface, is inbound and agent-initiated, unlike this ADR's outbound generation, so it gets its
   own ADR (as #615 asks).
5. **Identity gate.** ADR-008 Decision #5's full agent/delegation model must exist before any
   feature (including any writing MCP tool) commits an action without a human approver. Steps 1–3
   don't cross that line, so the gate stays deferred for them.

### Decision 7 — Model and provider choice is configuration, gated by an eval set

Model identifiers, per-feature generation parameters and provider credentials are read from
`@platform/config`, never hard-coded in feature code. Three reasons: model availability and naming
change on the provider's schedule, self-hosted operators may need a different model or endpoint,
and per-feature settings let summarisation and config generation use different models without a
code change. Decision 2 keeps the provider SDK an implementation detail of `packages/ai`.

A configuration change to a feature's model isn't trusted on inspection. Each feature keeps a small
fixture-based eval set in its package: for #614, NL descriptions with expected valid or invalid
rule outcomes; for #609, fixture portfolios containing known stalled and unassessable items. A
model change must pass that set before it is rolled out. Where it runs (CI with a live key, or a
manual pre-release step) is OQ-7.

### Resolved open questions

These were open in the first draft. Existing code, ADRs or an owner decision settle them.

- **Former OQ-4: AI context respects `__accessUsers` per-instance grants.** ADR-006's accepted gap
  concerns transition guards (write paths), which don't read `__accessUsers`. Read paths do.
  `hasEntityReadAccess`/`hasEntityAccess` (`packages/workflow-engine/src/entity-access.ts`,
  re-exported by `apps/api/src/lib/entity-access.ts`) grant read to admin/agent roles, the
  creator, the assignee, a `read_only`/`read_comment`/`read_write` `__accessUsers` grant, or a
  workflow admin. `apps/api/src/routes/entities/list.ts` scopes non-privileged lists to
  createdBy OR assignedTo OR an `__accessUsers` grant. Building AI context is a read, so it
  applies the same check for the same principal: `hasEntityAccess` per record, and the
  `listEntities` `scopeToUserId` scoping for sets. That check is already in `workflow-engine`,
  so any package or worker can call it (the reason it moved there, ADR-012 Phase C). A scheduled
  feature with no interactive caller (#609 digest) builds context per recipient, as that
  recipient, and never under a tenant-wide or system identity. The ADR-006 guard gap is
  untouched, since no 3C feature in Decision 6 steps 1–3 executes a transition.
- **Former OQ-8: `ANTHROPIC_API_KEY` becomes optional (owner decision; a separate PR makes the
  change in `packages/config/src/env.ts`).** Deployments without AI start normally. The gateway
  (Decision 2) checks for provider configuration before anything else. When it's absent, it
  returns a typed `AI_DISABLED` result instead of throwing, and it records no usage. Each feature
  reacts to that result the same way it reacts to the plan-cap degrade (Decision 3): the AI
  affordance is hidden, or a caller that asked explicitly gets a clear "AI is not configured"
  error, and the non-AI path keeps working. Renaming the key to provider-neutral config follows
  Decision 7 when the first feature lands. It isn't part of this change.

---

## Consequences

### Positive

- One enforcement point: metering, rate limits, context policy and logging apply to every AI call
  structurally, and a missing wrapper fails lint. Model upgrades become config changes.
- No new principal type, audit schema or execution primitive for the first slices. Attribution
  reuses the committing human (ADR-008).
- Generated config passes through the exact validation hand-authored config does. The existing
  `ActionConfigSchema` becomes the AI's output contract.
- ADR-015's reserved `ai_tokens` metric gets its producer with no schema change.

### Negative and mitigations

- **Draft-then-review adds a step.** Mitigation: every 3C issue requires it. Revisiting it goes
  through ADR-008 Decision #5, not a feature flag.
- **A strict public-only projection can starve the model of useful context**, producing vaguer
  output. Mitigation: per-feature allowlists can be widened deliberately with review, and a
  starved output shows up as low coverage (Decision 5) rather than confident guessing.
- **The rate-limit primitive fails open**, so a Redis outage removes the short-window AI cost
  control. Mitigation: ADR-015's daily plan cap remains, and OQ-1 proposes that the AI path fail
  closed.
- **`ANTHROPIC_API_KEY` is required at startup today** even though nothing uses it. Mitigation: it
  becomes optional, and the gateway returns `AI_DISABLED` when it is absent (former OQ-8, now
  resolved).

---

## Deferred Decisions

| Deferred item                                                       | Trigger to revisit                                                   | Why deferred                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Embeddings / vector index (#617 RAG, #628 NL search)                | A human starts #617 or #628 on confirmed need                        | New tenant-scoped store with RLS, refresh and erasure questions of its own; not needed by the first slice |
| MCP-native governed action surface (#615)                           | A human decides #615 is worth scoping (its own acceptance criterion) | Inbound, agent-initiated calls; needs its own ADR and the ADR-008 #5 identity model for any write tool    |
| Agent principal / delegation-chain identity (ADR-008 Decision #5)   | Any feature proposes committing an action without a human approver   | ADR-008's rule: stays deferred while 3C is human-in-the-loop                                              |
| Predictive/anomaly trigger (`ai.anomaly_detected`, #18 "Important") | Metric rollups exist and a human scopes it                           | Would add a new trigger type (engine primitive, ADR-004 #6) and depends on rollup data                    |
| Multi-provider routing / failover                                   | A deployment needs a second provider                                 | Decision 2 keeps it possible; no current requirement                                                      |
| Prompt/output body retention for debugging or evals                 | Eval or support need that metadata can't meet                        | Default-off is the data-minimisation-safe position (Decision 4)                                           |

---

## Open Questions

OQ-4 and OQ-8 were resolved and folded into the Decisions; see _Resolved open questions_ above.

| ID   | Question                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Should the AI gateway's rate-limit/budget check fail **closed**, unlike ADR-013's fail-open primitive?                                                     | **Proposed:** the AI gateway's rate-limit and budget checks fail closed. On a Redis error or timeout it returns a typed `AI_UNAVAILABLE` result, and the UI hides the affordance just as it does under plan-cap degrade. Ordinary API rate limits keep ADR-013's fail-open behaviour. Why: ADR-013 fails open (`rate-limit.ts:48–51`) because a Redis outage shouldn't block core API traffic. The AI checks are a cost-exposure control on a non-essential feature. Failing closed only hides an assistive button, while failing open leaves spend bounded only by ADR-015's daily-lagged cap. The second failure mode is the same one Decision 3 already requires for plan-cap degrade. Mechanism: `checkRateLimit` swallows errors and returns `allowed: true`, so it can't be told apart from a real allow. The gateway needs an opt-in failure signal from `packages/redis` (e.g. a `failMode: "closed"` option). That is an additive API change to a shared package, so it gets its own review. Needs human confirmation. |
| OQ-2 | Where do per-feature attribution and estimated cost live: extra `metric` values in `tenant_usage_daily` (e.g. `ai_tokens:<feature>`), or a separate table? | **Proposed:** use `tenant_usage_daily` with no new table. Keep the aggregate `ai_tokens` metric, which ADR-015 Decision #5's degrade and the plan cap read. Add `ai_tokens:<featureId>` for attribution and `ai_cost_micro:<featureId>` for estimated cost as an integer in micro-units of the configured currency (the `value` column is `bigint`, so fractional cost can't be stored directly). The price table is config (`@platform/config`), keyed by the Decision 7 model config id. Cost is computed at call time from that table and the provider-reported usage, so a later price change doesn't rewrite history. Why: ADR-015 Decision #3 chose the narrow `metric` column precisely so new billable metrics need no migration. The table already has RLS, isolation tests and a purge path. #618 asks for "tenant_id, token count, estimated cost", which daily granularity meets. Per-call rows would duplicate the metadata-only log in Decision 4. Needs human confirmation (metric naming and currency unit).    |
| OQ-3 | Should a model-reported confidence be shown to users at all, or only deterministic coverage counts?                                                        | **Proposed:** only deterministic coverage counts in v1, and no model-reported confidence score in any UI. The model may still mark an item "couldn't assess", which feeds the coverage count (Decision 5), but not as a number. Why: #609's acceptance asks that uncertain items be "explicitly flagged", not scored. A single uncalibrated number invites more trust than it has earned. Revisit only if an eval set (Decision 7) shows the score is calibrated for that feature. Needs human confirmation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| OQ-5 | What retention applies if a tenant opts into body retention, and does per-user erasure (ADR-015 Decision #4) need to reach it?                             | **Proposed:** only relevant if the deferred body-retention item is picked up. If it is, bodies go in a dedicated tenant-scoped table under ADR-015's per-tenant `retention_days` pattern with a short platform maximum, and yes, per-user erasure must reach it. Why: prompt and output bodies can quote free text containing personal data, so erasure has to delete them, not anonymise them. The existing drift guard (`apps/worker/tests/isolation/erasure-table-coverage-guard.isolation.test.ts`) already fails any new tenant table that isn't in `PURGED_TENANT_TABLES` or `ERASURE_EXEMPT_TABLES`, and per-user erasure lives in `apps/api/src/services/user-erasure.ts`. The table must be wired into both, not exempted. Needs human confirmation of the maximum retention value when the item is picked up.                                                                                                                                                                                                         |
| OQ-6 | Which provider data-use and retention terms are acceptable, and who verifies them per deployment (hosted vs self-hosted)?                                  | **Still open.** The acceptance bar is no training on submitted data and a bounded provider-side retention period. Proposed ownership: the platform operator verifies for the hosted deployment, and the operator of each self-hosted deployment verifies for their own provider account, as a documented deployment prerequisite. To close it, someone needs to read the current commercial terms or data-processing agreement for the specific provider account the hosted deployment will use and record three things: (a) whether API inputs and outputs are excluded from training, (b) the provider-side retention period and whether a zero-retention option applies to that account, (c) the processing region. Nobody in the repo has this, and it can change on the provider's schedule.                                                                                                                                                                                                                               |
| OQ-7 | Do eval sets run in CI (needs a live key, costs per run, and any CI change is human-only) or as a manual pre-release gate?                                 | **Proposed:** a manual pre-release gate first. Add a root script (e.g. `pnpm eval:ai`) that runs every feature's fixture eval set against the configured model. It is required before merging any change to a feature's model config or prompt, and the result summary goes in the PR description. CI wiring comes later and is done by a human, since `.github/workflows/` is human-owned. Why: evals need a live, billed key. In a public repo, secrets aren't exposed to fork PRs anyway, so a CI eval job would only run on trusted branches. It is also non-deterministic, which makes a poor required check. A manual gate tied to config and prompt changes covers the risk Decision 7 names. Needs human confirmation.                                                                                                                                                                                                                                                                                                  |
| OQ-9 | Should seed-SQL automation rules and AI-drafted rules share one validator in `packages/automation-engine` rather than an `apps/api` schema?                | **Proposed:** yes. Move `ActionConfigSchema`/`TRIGGER_TYPES` (and their dependents) from `apps/api/src/routes/automation-rules/schemas.ts` into `packages/automation-engine`, and have `schemas.ts` re-export them unchanged. Add a test that parses every module's seed automation rules against the schema. Why: `automation-engine` already owns Zod event schemas (`src/event-schemas.ts`) and depends on `workflow-engine`, the source of the `ConditionTree` type `schemas.ts` imports, so the dependency rule allows the move. `schemas.ts` itself records a seed rule that shipped with the wrong literal and silently never ran. The move-and-re-export pattern has a precedent in `entity-access.ts` (moved to `workflow-engine` in ADR-012 Phase C). An AI feature's pre-check then imports the package schema, and the gateway stays feature-agnostic. Needs human confirmation, because it adds exports to `automation-engine`'s public contract.                                                                  |

---

## Implementation status

Not started. No 3C feature is authorised by this ADR (see Status). When a human starts 3C:

1. Accept or amend this ADR, confirm the proposed answers to OQ-1 and OQ-2, and close OQ-6. These
   three block the first slice. OQ-8 is already resolved.
2. Pick the first slice (Decision 6, step 1). Write its spec under `docs/specs/`, covering
   Decisions 2–5 plus #618 metering in the same plan-lock.
3. Re-apply ADR-008 Decision #5's re-evaluation at that kickoff, as ADR-008 requires, and record the
   outcome in `docs/tracker/roadmap-tracker.md`'s 3C row.
