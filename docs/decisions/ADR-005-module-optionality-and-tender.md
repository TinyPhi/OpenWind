# ADR-005: Core vs. Optional Modules, and Retroactive Classification of `tender`

**Status:** Accepted  
**Date:** 2026-07-23  
**Deciders:** Engineering lead, Platform architect  
**Supersedes:** —  
**Amends:** ADR-004 (config-first module design) — this ADR extends ADR-004's module model with
an optionality dimension ADR-004 didn't need at the time it was written (Phase 2, 7-module
catalog, no concept of "not every tenant needs this one").  
**Superseded by:** —

---

## Context

### How this came up

A 2026-07-22 doc-reconciliation review found that PR #144 (2026-07-16) shipped a new
`modules/tender` vertical — real, working, config-first seed SQL — without any scoping decision
recorded anywhere. `architecture-brief.md`'s module map lists 8 modules (including _inventory_),
not _tender_; `roadmap-tracker.md`'s Phase 2 sub-item table lists the same 7 modules it always
has. Nothing said whether `tender` was meant to be a permanent, reusable part of the platform's
module catalog or a one-off.

Working through it in conversation surfaced a second, more general gap: **the platform has no
concept of "not every tenant needs this."** Every module today — including the original 7 — is
already opt-in per tenant (`modules.installModule`/`uninstallModule`, `tenants.config.
installed_modules[]`), and nothing auto-provisions even the modules Phase 2 treats as standard.
So "should `tender` be optional" turned out to be the wrong framing — _everything_ is currently
optional, informally, and undifferentiated. What's actually missing is the other half: a **core**
category that auto-provisions, so "optional" becomes a real distinction instead of the only state
that exists.

### What `tender` actually is (confirmed by direct code read, not assumption)

`modules/tender/` currently ships **one side** of tendering: the _submitting/applying_ side. Its
workflow (`draft → boq_preparation → pending_costing_review → costing_approved →
document_preparation → pending_submission_review → submitted`) models a team preparing and
submitting a bid for a tender issued by someone else. The issuing org is a plain `client_name`
text field — not a platform tenant, not a user account. Costing review is deliberately isolated as
a child ticket so the costing team never sees the parent tender's client/financial fields.

Per the human decision-maker (2026-07-23 conversation): the _issuing_ side (publish a tender,
receive applications from external vendors, evaluate, award) will be built later, **within the
same tenant** — a company can both issue tenders and apply to others' tenders under one account.
External counterparties (applicants on the issuing side, the issuing org on the submitting side)
are modeled as reference data only, the same way `client_name` already works — never as another
platform tenant, never requiring the counterparty to be an OpenWind customer. A true cross-tenant
tender marketplace (Tenant A's issued tender visible to Tenant B's users, live matching between
issuers and bidders) was explicitly ruled out as a _different product_, not a module.

This matters for the decision below: because both sides stay single-tenant and external parties
are never platform users, `tender` requires **no new engine primitive** — no cross-tenant
visibility, no new authentication model, nothing ADR-004's checklist would flag as needing an
engine PR. It fits the config-first model as-is.

### Current mechanics (confirmed by direct code read)

- `packages/db/src/schema/platform.ts`: `modules` table has `slug`, `name`, `description`,
  `version`, `isSystem` (bool), `minPlan` (free-text, default `"standard"`). No `category` column.
  No tenant↔module junction table — installed state lives in `tenants.config.
installed_modules: string[]` (a JSONB array, not a relation).
- `apps/api/src/services/module-service.ts`: `installModule`/`uninstallModule` are the only path
  that changes a tenant's installed set. `minPlan` is never read or compared against `tenants.
plan` anywhere in the codebase — it's a UI badge only (`apps/admin-ui/src/pages/modules.tsx`),
  not an enforced gate. It predates this ADR and isn't something this decision activates.
- `apps/api/src/lib/tenant-lifecycle.ts`: `provisionTenant` never calls `installModule`. **Every
  new tenant starts with zero modules installed**, full stop — this is true for helpdesk and CRM
  today, not just for anything new.
- No entitlements/billing/license concept exists anywhere in the repo (grepped for all of
  `entitlement|billing|license|tier` — zero hits beyond the two decorative fields above).

### This project is open source — scope boundary up front

OpenWind is an open-source platform. This ADR is about **installation defaults** — does a module
ship enabled by default (`core`), or does an admin have to explicitly turn it on (`optional`) —
not about monetization, licensing, or paid tiers. The word "tiering" is deliberately avoided below
except when describing the rejected option, because it invites exactly that conflation. See "Not
in scope" at the end of the Decision section.

---

## Evaluated Options

### Option 1: Leave it as-is — no formal classification, decide `tender`'s status by fiat

Just write a one-line note somewhere saying "`tender` is a supported module," without touching the
schema or provisioning code.

**Advantages:** Zero engineering work.
**Disadvantages:** Doesn't fix the actual gap (nothing distinguishes "everyone gets this by
default" from "opt-in extra" — there is no "everyone gets this by default" today at all, for any
module). The next module after `tender` hits the exact same undocumented-scope problem this ADR
exists to close. Punts a real product question (should core modules auto-provision?) indefinitely.

### Option 2: Add a `category` column (`core` | `optional`) and auto-provision `core` on tenant creation ✅ Selected

Add `modules.category` (`core` | `optional`). Tenant provisioning auto-installs every
`category = 'core'` module; `optional` modules stay exactly as they work today — opt-in via the
existing install API, nothing changes for them. Classify the original 7 (helpdesk, reimbursements,
crm, projects, hrms, invoicing, procurement) as `core`; classify `tender` as `optional`.

**Advantages:** Small, additive change — reuses 100% of the existing install/uninstall/registry
machinery; only adds a field to the existing per-module definitions and one loop in
`provisionTenant`. Makes "optional" a real, meaningful distinction instead of the only state that
exists. Matches stated business intent directly ("tender would be reusable... but not all would
need it"). Purely an installation-default mechanism — carries no licensing or monetization
meaning, consistent with this being an open-source project.
**Disadvantages:** `modules.isSystem` already exists, is already surfaced as a `"Core"` badge in
`apps/admin-ui/src/pages/modules.tsx`, and is currently inert only because `seedRegistry()`
hardcodes it `false` for every module. Introducing a second, differently-scoped `category`
concept without reconciling this risks two different "Core" labels meaning two different things
in the same UI (see Decision below for how this is resolved). Existing tenants also end up with a
stale `installed_modules` list relative to the new default — judged an acceptable, explicitly
deferred cost, not an unaddressed one (see Consequences > Negative).

### Option 3: Entitlements/billing-gated module access — rejected for this ADR

Build real plan-tier enforcement: compare `tenants.plan` against `modules.minPlan` at install
time, define a plan hierarchy, likely tie into a billing system.

**Advantages:** Would let a commercial product built on top of this open-source project gate
premium modules behind paid plans.
**Disadvantages:** Not appropriate to design into the open-source project's own architecture
decision — OpenWind itself has no licensing/billing model, and baking monetization plumbing into
the core ADR conflates "does this module install by default" (a real, present product question)
with "who is allowed to pay for what" (not this project's concern). **Not selected** — see "Not in
scope" below for where this actually belongs.

---

## Decision

**Adopt Option 2.** Add a `category` column to the `modules` registry table (`core` | `optional`,
values used today: `core` for the 7 standard modules, `optional` for `tender`). Tenant
provisioning auto-installs `core` modules; `optional` modules remain exactly as opt-in as every
module is today — no behavior change for them, no plan-gating added.

**`tender` is ratified as a standalone module** (not folded into `@modules/procurement` — its
submitting-side workflow, with isolated child-ticket costing review and multi-stage document
prep, is a genuinely different and richer shape than procurement's linear RFQ flow), classified
`category = 'optional'`.

The issuing side of tendering (publish, receive external applications, evaluate, award) is
**future scope, not yet built** — when it lands, it follows the same rule already proven by the
submitting side: single-tenant, config-first, external counterparties as reference data, no new
engine primitive. (Its costing-isolation precedent on the submitting side is a manual process
today, not an automated one — see #162 — so "proven" here means the _data shape_, not that the
automation exists yet.)

### `category` lives in code, alongside the module's other metadata — not a migration backfill

`apps/api/src/services/module-service.ts`'s `seedRegistry()` already hardcodes a literal
`standardModules` array (slug/name/description/version/`isSystem`/`minPlan`) for all 8 modules,
including `tender` — this is the existing, established place module classification metadata is
authored in this codebase. `category` belongs there too, as one more field per module, not in a
separate config file (which would create a second source of truth for module metadata next to
this array, for no real gain — nothing here needs runtime/non-engineer editability) and not as a
pure DB/admin-toggle (which would turn "what ships by default," a rare and deliberate platform
decision, into an ad-hoc runtime switch with its own unanswered questions — can a superadmin flip
CRM to optional? does that retroactively uninstall it for existing tenants?).

**A migration-time `UPDATE ... WHERE slug IN (...)` backfill does not work for this**, because
`modules` rows only ever get created by `seedRegistry()` at runtime (lazily, on first
`listModules()` call) — the table is empty at migration time in every normal deployment path, so
such an `UPDATE` would silently affect zero rows, and every module would then get inserted relying
on the column's default. `category` must be set in `standardModules` itself, the same place
`isSystem`/`minPlan` already are.

**Required companion fix, not optional:** `seedRegistry()`'s `onConflictDoUpdate` currently only
updates `name`/`description`/`version`/`updatedAt` on conflict — it never re-applies `isSystem` or
`minPlan` to a row that already exists. This is a pre-existing gap (changing either value in the
array today silently has no effect on an already-seeded environment), and `category` would inherit
the exact same problem if added without fixing this. The `set` clause must include `category`
(and, while touching this, should include `isSystem`/`minPlan` too) or reclassifying a module
later won't propagate to any environment that's already seeded — including the existing demo
tenant.

**Resolving the `isSystem` naming collision:** `isSystem` already exists and is already labeled
`"Core"` in the admin UI (`apps/admin-ui/src/pages/modules.tsx`), currently inert only because
every module hardcodes it `false`. Rather than introduce a second, differently-scoped concept
under a colliding label, `category` and `isSystem` need distinct, non-colliding meanings: `category`
answers "does this auto-install by default" (this ADR's concern); `isSystem` is left for a
different, still-unused axis (e.g., "platform-owned template, not tenant-forkable") and its UI
badge should stop saying `"Core"` — reword it (e.g. `"Built-in"` or remove the badge until
`isSystem` has a real, distinct use) so the two concepts don't visually collide.

### Implementation sketch

1. Migration: `ALTER TABLE modules ADD COLUMN category text NOT NULL DEFAULT 'optional' CHECK
(category IN ('core', 'optional'))` (or an enum, matching this repo's existing enum
   conventions in `packages/db/src/schema`). No backfill statement needed — see above.
2. `apps/api/src/services/module-service.ts`: add `category: "core"` to the 7 standard modules'
   entries in `standardModules`, `category: "optional"` to `tender`'s entry. Add `category` (and
   `isSystem`, `minPlan`) to the `onConflictDoUpdate` `set` clause so re-seeding actually updates
   already-existing rows.
3. `apps/admin-ui/src/pages/modules.tsx`: group the existing flat grid by `category` (e.g., two
   sections, "Core" and "Optional"); reword or remove the `isSystem`-driven `"Core"` badge per
   above so the two concepts don't collide in the UI.
4. `apps/api/src/lib/tenant-lifecycle.ts`'s `provisionTenant`: after inserting the tenant row, loop
   `category = 'core'` modules through the existing `ModuleService.installModule` path (reuse it,
   don't duplicate its seed-running logic). **This loop needs transactional/partial-failure
   handling before it ships — tracked separately as #163, not solved by this ADR.**
5. No change to `installModule`/`uninstallModule`/`minPlan` — those stay exactly as they are.

### Known implementation gaps this ADR surfaced but doesn't resolve

Adversarial review of this ADR (2026-07-23) turned up three pre-existing gaps in code this
decision touches, none of which this ADR is responsible for fixing — tracked as their own issues
so they aren't lost, and so whoever implements this ADR isn't ambushed by them:

- **#161** — 6 of the 7 `core`-candidate modules have non-idempotent seed SQL (no
  `WHERE NOT EXISTS` guard, unlike `helpdesk`) — a real risk once retrying a failed install
  becomes a more common path (see #163).
- **#162** — `tender`'s costing-isolation automation rule ships disabled and references a
  nonexistent action type; the isolation is manual today, not automated.
- **#163** — `provisionTenant` isn't transactional; auto-installing multiple `core` modules during
  provisioning (step 4 above) needs partial-failure handling before it ships. Depends on #161.

### Not in scope: commercial licensing/tiering

This ADR does not define, enable, or plan for any paid-tier, entitlement, or licensing mechanism.
`category` (`core`/`optional`) is purely about installation defaults for the open-source project.
The pre-existing `modules.minPlan`/`tenants.plan` fields stay exactly as decorative and unenforced
as they are today — this ADR doesn't activate them.

If a commercial adopter builds a product on top of this open-source repository and wants to gate
`optional` module installs behind a paid plan, that is a legitimate extension to make in their own
fork/deployment — e.g., layering entitlement checks on top of `category`/`minPlan` in their own
`installModule` wrapper — but it is explicitly **not** a decision this ADR makes for the
open-source project, and is out of scope for anyone implementing this ADR as written.

---

## Consequences

### Positive

- Closes the actual gap: "core" now means something, so "optional" is a real distinction instead
  of the default state of everything.
- `tender`'s status is now a recorded decision, not silent scope drift — the next module (9th,
  10th, ...) has a clear classification to slot into instead of repeating this review.
- Near-zero new machinery — reuses the existing install/seed/registry path end to end.
- Matches ADR-004's own module definition unchanged; this ADR only adds a classification label, it
  doesn't touch what a module _is_ or the config-first checklist.
- Keeps the open-source project's architecture free of any licensing/monetization concern —
  commercial concerns, if any arise later, stay in downstream forks, not in this repo's core ADRs.

### Negative

- Every existing tenant that predates this change has an empty or partial `installed_modules`
  list relative to the new "core" default. **Resolved (2026-07-23), per the repo owner's own
  knowledge of current deployment state** (not independently verifiable from this codebase/session
  — there is no live-tenant-count check possible from the repo alone): only one demo tenant has
  been installed to date, so a full backfill migration strategy isn't worth designing yet. When
  the `category` column ships, that one tenant can be reseeded directly. Revisit properly once
  there's real tenant volume where a manual fix-up stops being practical.

### Reversibility

The schema change itself is fully reversible: `category` is metadata on an existing table, and
removing or changing it doesn't touch `tenants.config.installed_modules[]` directly. **This does
not mean the mechanism's effects are reversible** — modules that got auto-installed into a
tenant's `installed_modules[]` while `category='core'` was live stay installed if the column is
later dropped or changed; reverting the classification doesn't uninstall anything that already
happened as a result of it.

---

## Open Questions

- **Backfill:** resolved (per the repo owner, 2026-07-23), see Consequences > Negative above —
  not worth solving until there's real tenant volume beyond the single demo install.
- **Third category:** deferred, no decision needed now. A third value (e.g. `experimental`) is a
  real possibility once there's a concrete case for it — none exists yet, so `core`/`optional`
  stays sufficient until one does.
- **Issuing-side tender workflow — house it in `tender` or fold into `procurement`?** Still
  genuinely open, not yet designed. Current leaning (2026-07-23 conversation, not a final
  decision): keep it in `tender` as a second entity type rather than extending procurement's RFQ.
  Procurement's Vendor/RFQ/Draft→Approved→Sent→Fulfilled flow is structurally close to "publish a
  solicitation, receive vendor responses, award," but a formal tender typically needs more than
  that — a published deadline, technical/financial bid evaluation kept separate (mirroring the
  isolated child-ticket costing-review pattern already built for the submitting side), and a
  formal award with a recorded justification. Splitting one described capability ("tendering, both
  sides") across two modules also weakens the admin experience for no clear gain. If an awarded
  tender needs to become a real Purchase Order internally, that's a cross-module automation rule
  (`tender.awarded` → procurement PO creation via the event bus, per ADR-004/CLAUDE.md's
  cross-module communication rule) rather than a reason to merge the modules. Worth its own
  `/spec` when work on the issuing side starts — this note is a leaning to carry into that spec,
  not a substitute for it.
