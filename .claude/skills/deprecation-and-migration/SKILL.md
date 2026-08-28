---
name: deprecation-and-migration
description: Plans safe removal or migration of existing systems, credentials, or schema shapes — grace periods, dual-running, and rollback. Invoke for api_keys rotation/scopes-format migration (OQ-2/OQ-3, ADR-008), module uninstall/reinstall paths, or any breaking schema/contract change with existing callers.
---

# Skill: deprecation-and-migration

Code and data shapes are a liability, not an asset — every live shape has an ongoing cost
to support. Deprecation is removing what no longer earns its keep; migration is moving
callers off the old shape without breaking them mid-flight. At OpenWind this is not
hypothetical — it's a named open gap.

---

## When to use

Invoke when:

- Resolving OQ-2/OQ-3 (ADR-008 Stage 1): the forced-migration/grace-period windows for
  `api_keys` rows that predate `expires_at`/rotation/soft-revoke
- Migrating `api_keys.scopes_format` from `'role'` to `'action'` (ADR-008 Decision #6 /
  issue #370) — existing keys stay on legacy role-strings today; someone eventually has to
  move them
- Changing a module's seed SQL shape where tenants have already installed the old shape
  (module uninstall retains data — an upgrade path needs a real migration, not just a flag flip)
- Removing a deprecated route, field, or event-bus payload shape that has existing callers
- Planning a new system's lifecycle at design time (deprecation planning starts before
  ship, not after)

Skip for code with zero external callers — that's just deletion.

---

## Core moves

**Know who depends on the old shape before removing it.** For `api_keys`, that means: which
existing keys are unmigrated role-format scopes, which connectors/partners hold long-lived
keys, and whether any Tier-1 partner (ADR-010) would be silently broken by a scope reshape.

**Dual-run, don't hard-cutover.** The `scopes_format` CHECK-constrained discriminator
(migration 0055) is the dual-run mechanism already in place — both formats are valid
simultaneously. The missing piece is `scope-ceiling.ts` still rejecting any `'action'`-format
scope; don't lift that until the privilege-ceiling rule for the new verb set actually exists
(see the two forward-compat traps already flagged in PR #373's review: `resolve_api_key_by_hash`
not returning `scopes_format`, and `rotate.ts`'s `scopeCeilingError` call).

**Grace period is a decision, not a default.** OQ-2/OQ-3 are explicitly _not_ a build task —
they need a human call on the grace/rotation window length, since that's a support-and-breakage
tradeoff, not an engineering one. Surface it rather than picking a number silently.

**Reversible until it isn't.** A migration should be rollback-safe up until the old shape is
actually dropped. Don't drop the old column/format/route in the same change that starts
writing the new one — land the write-path change, let it bake, then remove the old shape in
a follow-up once nothing reads it anymore.

---

## OpenWind-specific checklist

- [ ] Does this migration have a rollback path, or is it a one-way door? If one-way, say so
      explicitly rather than let it look reversible.
- [ ] Old and new shapes can coexist for at least one deploy cycle (dual-run), unless there's
      a stated reason a hard cutover is safe
- [ ] Isolation tests cover both the pre-migration and post-migration shape under RLS
      (`testing-conventions.md`) — this project already did this for the `scopes_format`
      migration itself (2026-08-12); match that bar for anything downstream of it
- [ ] The grace-period/cutover date, if one exists, is a decision recorded somewhere durable
      (roadmap tracker, ADR, or an explicit BLOCKERS.md entry) — not implied by code alone

---

## Flag, don't guess

If a migration's grace window, forced-cutover date, or "is anyone still using the old shape"
question isn't answered anywhere in the ADR or tracker, that's a BLOCKERS.md-worthy stop per
`agent-behaviour.md` — not a judgment call to make silently, since picking a window that's too
short breaks real integrations and picking one that's too long keeps a known-weaker shape live
longer than intended.
