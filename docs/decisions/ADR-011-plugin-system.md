# ADR-011: Plugin System — Module Federation, Slot Registry, and Lifecycle Service

**Status:** Accepted  
**Date:** 2026-08-19.  
**Deciders:** Engineering lead (@abmish) — implementation decisions were made 2026-08-13; this ADR
formalizes them for review/acceptance.  
**Supersedes:** —  
**Related to:** ADR-004 (config-first module design — this system is the explicit escape hatch for
what config-first can't express), ADR-008 (`scopes_format` discriminator precedent, reused here for
`trust_tier`), ADR-009 (connector runtime — parallel first-party-only trust-tier decision, and the
catalog/credential table-split precedent this ADR reuses).  
**Superseded by:** —

---

## Context

### Scope

3B is the escape hatch for capabilities the three engines (Entity/Workflow/Automation) genuinely
cannot express: new data models with custom backend logic, new API routes, new job types, richer
frontend beyond generic `view_configs`-driven views. It is explicitly **not** a way around ADR-004's
config-first rule for anything the engines can already express — that stays seed SQL, always. 3B is
technically independent of 3A/3C/3D (no shared schema, no shared runtime); it depends only on #13
(2B module system, already shipped), which validated the simpler "install = apply config" model this
system extends into "install = register real code."

### What actually executes today, vs. what's declared but not loaded

**Corrected during adversarial review (2026-08-19) — the first draft of this ADR overstated this.**
What PR #397 actually wired up:

- **Plugin migrations run for real**, against a dedicated `plugin_<slug>` schema, under a
  schema-scoped role grant (Decision #3). This is genuine arbitrary-DDL execution.
- **The install/uninstall lifecycle runs for real** (`plugin-lifecycle.ts`): dependency resolution,
  manifest/version validation, the migration-lint gate (Decision #7), `installed_plugins` status
  transitions, and tenant-scoped data cleanup on uninstall (Decision #8).
- **The Module Federation loader, SRI verification, and `<Slot>` component are implemented and
  unit-tested** (Decisions #5/#6) — but have **zero production callers**. No admin-ui page renders
  a `<PluginSlot>`, and no real plugin has ever been loaded through `loadPluginRemote` outside its
  own test file, because no first-party plugin has shipped yet.
- **`PluginManifest.routes`/`hooks`/`jobs` are declared schema fields with no loader.**
  `plugin-lifecycle.ts`'s own top-of-file comment states this plainly: _"No route/hook/job
  registration of the plugin's own routes/hooks/jobs yet ... no mechanism exists yet to actually
  load and mount that code (that's follow-on work once a real first-party plugin exists to validate
  the shape against, matching this spec's own scope note that this phase is data/lifecycle only)."_
  **A plugin cannot run arbitrary backend code today** — it can run arbitrary migrations, and that's
  the whole of what "runs" means for a plugin in this phase.

This matters because Decision #1's trust-tier severity argument, and Decision #3's original framing
in this ADR's own first draft, both described "a plugin can run arbitrary backend code" as a present
capability. It is not — it is the capability this system is designed to eventually grant, gated
behind a loader that doesn't exist yet. Every decision below is written against what actually ships
today; where a decision is really about a not-yet-built capability, that's called out explicitly
rather than implied.

---

## Decision (as implemented)

1. **Trust tier: v1 ships first-party only, enforced as a DB-level gate, not a comment.**
   `plugin_definitions.trust_tier text NOT NULL DEFAULT 'first_party' CHECK (trust_tier IN
('first_party'))`. This mirrors ADR-009's parallel first-party-only call for connectors. Today
   the gate constrains **arbitrary plugin-authored DB migrations** — already a larger blast radius
   than a connector's constrained `callApi()`, since a migration can create tables, alter grants, or
   run arbitrary SQL. It is also pre-positioned for arbitrary backend code (routes/hooks/jobs) once
   that loading mechanism exists (see Context) — the CHECK constraint doesn't need to change when
   that ships, but the trust-tier decision itself should be re-examined at that point, since the risk
   calculus for "runs migrations" and "runs request-handling code" isn't identical. Reopening to
   third-party is a deliberate future decision (a CHECK-constraint change), mirroring ADR-008's
   `scopes_format` discriminator precedent (`packages/auth/src/scopes.ts`) — built as an explicit
   column specifically so its own future reopening is a small, visible change rather than a migration
   redesign.

2. **Two-table catalog/install split**, matching the `connector_definitions`/`connector_credentials`
   precedent (ADR-009 Decision #8): `plugin_definitions` (platform-wide catalog, no `tenant_id`/RLS,
   readable by `app_user`) and `installed_plugins` (tenant-scoped install row with `manifest_snapshot
jsonb` frozen at install time, so a later `plugin_definitions` update doesn't retroactively change
   what's already running for an installed tenant). Composite unique index `(tenant_id, plugin_id)`
   prevents double-install. `plugin_errors` (tenant-scoped, RLS) captures every lifecycle failure or
   migration-lint rejection instead of crashing the platform process. **Correction:** unlike
   `connector_definitions`, `plugin_definitions` has **no admin-role write endpoint** —
   `apps/api/src/routes/plugins/` never writes to it. A catalog row can only be created via
   migration/seed today (`migration_user` only), not through any API. This ADR's first draft
   incorrectly borrowed the connector precedent's "writable only by `migration_user`/admin-role
   endpoints" phrasing without checking whether the admin-endpoint half actually exists for plugins.

3. **Postgres schema namespace isolation for plugin migrations, enforced by grant, not convention.**
   Each plugin gets a dedicated schema `plugin_<slug>`; the role a plugin's migration runs under has
   `CREATE`/`USAGE` on that schema only, via a `SECURITY DEFINER` function
   (`create_plugin_schema()`). This isolates plugins **from each other** for the one thing that
   actually executes today (migrations) — it does not by itself isolate tenants **within** one
   plugin's tables (see Decision #7). **Correction:** this ADR's first draft additionally claimed
   "the plugin SDK exposes its own scoped client as the only DB handle available to plugin code,"
   closing a bypass of both the schema restriction and the governor limits (Decision #4). **No such
   client exists anywhere in `packages/plugin-sdk`** (`index.ts`, `manifest-schema.ts`, `types.ts`
   only) — that claim was fabricated, not verified. It's also moot today regardless, since there is
   no plugin _runtime_ code to restrict yet (Context) — only migrations run, and those are already
   constrained by the role grant itself, not by a wrapped client. A real DB-entry-point restriction
   for plugin _request-handling_ code is necessary future work, not something already built — see
   Deferred Decisions.

4. **Governor limits are implemented and unit-tested, but not wired into any live call path.**
   Verified directly against `apps/api/src/services/plugin-governor.ts` and confirmed by grep: no
   file outside `plugin-governor.ts` and `plugin-governor.test.ts` calls `applyQueryGovernor`,
   `checkRowCeiling`, or `withJobTimeout` — `plugin-lifecycle.ts` imports none of them. This ADR's
   first draft described these as live enforcement ("a runaway query is actually cancelled
   server-side"); that describes what the function does in isolation, not what happens to a plugin
   today, since there is no plugin query or job execution path yet for it to guard. What's real: the
   three functions exist, are correctly unit-tested, and have distinct designed postures worth
   preserving for when they're wired up —
   `DEFAULT_QUERY_TIMEOUT_MS = 5_000` via `SET LOCAL statement_timeout` would hard-cancel a runaway
   query server-side; `DEFAULT_ROW_CEILING = 10_000` is designed as a soft, post-hoc, non-blocking
   check; `DEFAULT_JOB_TIMEOUT_MS = 30_000` (`withJobTimeout`) is designed to log a breach without
   ever cancelling the job. Wiring these into an actual plugin execution path is tracked as its own
   Deferred Decision below, alongside route/hook/job loading generally — there's no execution path
   for them to guard until that ships.

5. **Module Federation for plugin UI integration, not iframe+postMessage** — justified specifically
   by the first-party-only trust tier (Decision #1): shared JS runtime, richer UI integration,
   acceptable risk because every live plugin would be platform-authored. `apps/admin-ui/src/lib/
plugin-remote-loader.ts` uses `@module-federation/runtime`'s `registerRemotes`/`loadRemote`
   directly — admin-ui only ever _consumes_ a plugin's remote dynamically at runtime, so no
   build-time `vite.config.ts` change was needed. **Correction: this has zero production callers
   today.** The loader and `<PluginSlot>` (`apps/admin-ui/src/components/plugin-slot.tsx`) are
   exercised only by their own unit tests — no admin-ui page renders a `<PluginSlot>`, because no
   first-party plugin with a UI has shipped yet to load. If the trust tier is ever reopened, this
   choice must be revisited too — Module Federation's shared-runtime model is a poor fit for
   genuinely untrusted code (a bad plugin can affect host memory/state).

6. **SRI (SHA-384-class) hash validation on `remoteEntry.js`, with the verified bytes pinned, never
   re-fetched.** Kept as Core despite first-party trust (catches CDN/build-pipeline tampering, not
   just malicious authorship; retrofitting onto every already-installed plugin later would cost more
   than building it now). A naive verify-then-fetch-again implementation has a TOCTOU gap — the
   shipped code (`parseSriIntegrity`/`verifyIntegrity`/`loadPluginRemote`) closes it the same way this
   codebase's connector-sdk DNS-rebinding fix does elsewhere: verify once, wrap the verified bytes in
   a same-origin `blob:` URL, and register only that blob URL with the federation runtime — the
   original remote URL is never re-resolved. Correctly implemented and unit-tested; carries the same
   "zero production callers yet" caveat as Decision #5, since it's exercised by the same unused
   loader path.

7. **Tenant isolation within a plugin's own tables is a separate, explicit requirement from schema
   namespacing (Decision #3).** Any table a plugin migration creates that stores tenant-scoped data
   must carry `tenant_id NOT NULL` + the platform's standard RLS pair — the same two-layer rule
   `security.md` makes non-negotiable for platform tables. `apps/api/src/services/
plugin-migration-lint.ts` statically rejects a plugin migration creating a table without both,
   with an explicit `-- plugin-lint: not-tenant-scoped (reason)` opt-out for genuinely
   non-tenant-scoped tables (mirroring this repo's own `-- analytics: excluded (reason)`
   convention). **Hardened during PR #397 review (finding credited to @PrabhuVijit):** the initial
   check only confirmed a `CREATE POLICY` statement's _presence_, which let a policy body of
   `USING (true)` — allow every row to every caller — pass identically to a real tenant-isolation
   policy, defeating this lint's purpose the moment a plugin exposed that table through a route. The
   lint now captures the full policy statement and requires it to actually reference `tenant_id`.
   This is the one piece of plugin-authored-code enforcement that is real and load-bearing today,
   because migrations are the one piece of plugin-authored code that actually runs.
   Tenant deletion (`apps/worker/src/tenant-purge.ts`) is extended to enumerate every installed
   plugin's schema for the deleted tenant and delete `WHERE tenant_id = ?` there too — a tenant
   being deleted is a different event from a tenant uninstalling one plugin (Decision #8), and both
   must fully remove that tenant's data.

8. **Plugin uninstall deletes that tenant's rows from every table in the plugin's schema (unless
   `retainData=true`), but never drops the schema itself.** Corrected during implementation from an
   earlier assumption: `plugin_<slug>` is shared by every tenant with that plugin installed (Decision
   #2), so dropping it on one tenant's uninstall would destroy every other tenant's data.
   Schema-level teardown (safe only once zero tenants have a plugin installed) is not built in v1.

9. **`@platform/plugin-sdk` versioning shipped as a platform-compatibility check, not a deprecation
   policy.** Verified against `packages/plugin-sdk/src/version-compat.ts`:
   `isPlatformVersionCompatible()` validates a plugin's declared `platformVersion` range (exact,
   `>=`, or `^`) against the running platform at install time, failing closed on anything
   unparseable — this is real and enforced. What did **not** ship, and is not retroactively declared
   "decided" by this ADR because no actual decision was made on it: a semver-versioned API stability
   contract for the SDK's _own_ breaking changes, or a documented deprecation-period policy. The
   package remains pinned at `0.0.1` (`packages/plugin-sdk/package.json`) with no CHANGELOG. Tracked
   as its own open item — see issue #433 and Deferred Decisions below.

10. **`PluginManifest.ui.remote` is an unconstrained string — no origin allowlist, no CDN mirroring.**
    Verified against `packages/plugin-sdk/src/manifest-schema.ts` (`remote: z.string().min(1)`).
    Nothing in the spec or the shipped code enforces that a remote comes from a platform-controlled
    origin. This is very likely inconsequential under the first-party-only trust tier (every remote
    would be platform-authored) — but that is an inference this ADR is making now, not a decision
    any prior document actually recorded. See Deferred Decisions.

---

## Consequences

### Positive

- The trust-tier CHECK constraint and schema-namespace-by-grant give two hard, DB-enforced
  boundaries (not review-time conventions) for the one plugin-authored-code path that actually runs
  today (migrations) — consistent with this codebase's general preference for structural enforcement
  over convention (RLS, the migration lint's `tenant_id`+RLS check).
- Reusing the `connector_definitions`/`connector_credentials` catalog/install split (ADR-009) and
  the `scopes_format`-discriminator pattern (ADR-008) for `trust_tier` means this system's shape is
  already familiar to anyone who has read those two ADRs, not a third bespoke pattern.
- SRI validation, the Module Federation loader, and the governor-limit functions were all built and
  unit-tested now, ahead of any real plugin needing them — cheap to build correctly today (zero
  production traffic to break), expensive to retrofit later. They just aren't wired into a live path
  yet (see Negative and gaps).
- The PR #397 review process caught and fixed a real tenant-isolation bypass (Decision #7's
  `USING (true)` gap) before it shipped — the lint mechanism worked as intended even though the
  first version of it had a hole.

### Negative and gaps

- **This ADR is retroactive**, written 6 days after PR #397 merged, for a change whose intended end
  state (Decision #1) is "categorically larger blast radius than a connector" — exactly the kind of
  change this codebase's ADR convention exists to gate _before_ implementation, not after.
- **The single largest gap: there is no mechanism to load and mount a plugin's routes, hooks, or
  jobs.** `PluginManifest.routes`/`hooks`/`jobs` are declared, optional string fields with no
  consumer. Everything this ADR says about "arbitrary backend code" is about a target capability,
  not a shipped one — see Context. `docs/sup-docs/roadmap-tracker.md` marks 3B "✅ Done ... all 3
  phases ... 100%"; that's consistent with 3B's own scoped deliverable (data + lifecycle + UI-loading
  plumbing, no real plugin onboarded yet) but inconsistent with how "100%" reads next to a
  system whose headline capability doesn't exist yet. Worth reconciling explicitly — see OQ-4.
- **The governor limits (Decision #4) are unwired** — built and correctly unit-tested in isolation,
  called from nowhere else. There is currently nothing for them to guard, since no plugin query or
  job execution path exists; this stops being cosmetic the moment route/hook/job loading ships, and
  should land in the same change, not after.
- **The Module Federation/SRI/`<Slot>` path (Decisions #5/#6) has zero production callers** — no
  admin-ui page has ever rendered a real plugin UI through it.
- **The SDK versioning/deprecation-policy gap (Decision #9) has no owner or timeline as of this
  ADR** — tracked as issue #433, not resolved here.
- **No origin allowlist or CDN mirroring exists for plugin remotes (Decision #10)** — likely moot
  under first-party trust, but that was never an explicit decision anyone wrote down until now.
- **Plugin migrations are forward-only** — no up/down pair mechanism, no admin-approval gate on
  irreversible DDL. The install-time lint (Decision #7) enforces tenant-isolation shape, not
  rollback safety. This was never explicitly decided as out-of-scope in writing before now.

---

## Deferred Decisions

Named explicitly, each with a trigger condition — not silent omissions.

| Deferred item                                                                                                                                                                                                                                                                                    | Trigger to revisit                                                                                                                                                   | Why deferred                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin route/hook/job loading mechanism — actually load and mount a real installed plugin's registered routes/hooks/jobs at runtime, plus the DB-entry-point restriction (a real scoped client, replacing Decision #3's retracted claim) and wiring Decision #4's governor limits into that path | A real first-party plugin needing this capability is built                                                                                                           | Deliberately out of scope for this phase per the original spec's own framing ("data/lifecycle only") — declared in the manifest schema but no loader exists. This is the capability everything else in this ADR is designed in anticipation of. |
| Third-party/open marketplace enrollment                                                                                                                                                                                                                                                          | A named prospective third-party developer or customer asks to install plugin code the platform team didn't author                                                    | Requires, at minimum: a review/vetting pipeline, hard (not soft) governor limits across all three dimensions once wired, and Module Federation (Decision #5) replaced or supplemented with iframe isolation. Not designed here.                 |
| CDN mirroring / origin allowlist for plugin remotes (issue #6 checklist item)                                                                                                                                                                                                                    | Trust tier reopens, or an explicit decision to mirror even first-party remotes                                                                                       | Never built; likely moot under first-party trust but never formally waived — see Decision #10.                                                                                                                                                  |
| `@platform/plugin-sdk` semver/deprecation policy                                                                                                                                                                                                                                                 | Before a second real external consumer is built against the SDK                                                                                                      | Only the platform-version compatibility check shipped; the deprecation-period policy itself was never decided. Tracked in issue #433.                                                                                                           |
| Reversible (up/down) plugin migrations + admin approval on irreversible DDL                                                                                                                                                                                                                      | Before opening the plugin marketplace to third-party developers (same trigger as issue #6's checklist)                                                               | Not built; forward-only migrations were an implicit outcome of implementation, not an explicit decision, until this ADR names it.                                                                                                               |
| Plugin billing/usage metering                                                                                                                                                                                                                                                                    | 3C/3D's `tenant_usage` table design lands                                                                                                                            | Resource consumption by a plugin isn't wired into any usage table yet — plugins are a future consumer of that schema, not a co-designer of it.                                                                                                  |
| Cross-plugin communication (RPC/shared state)                                                                                                                                                                                                                                                    | A specific plugin pair has a real requirement (e.g. transactional cross-plugin writes, or latency) that the entity engine's relations API is measured to not satisfy | No special-cased plugin bus exists; a plugin needing another plugin's data goes through the entity engine's relations API like any other consumer, until a concrete case proves that insufficient.                                              |
| Plugin-schema teardown on last uninstall                                                                                                                                                                                                                                                         | The last tenant with a given plugin installed uninstalls it (detectable today via `installed_plugins`; only the teardown mechanism itself is unbuilt)                | An empty, unused `plugin_<slug>` schema is cheap to leave around; no flow exists to fully retire a plugin catalog entry yet.                                                                                                                    |

---

## Open Questions

| ID   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Still open (confirmed 2026-08-24): no allowlist/CDN logic exists in `packages/plugin-sdk` or `apps/admin-ui` — only SRI hash verification (`plugin-remote-loader.ts`), confirmed by its test file using arbitrary `cdn.example.com` URLs with no origin check. Issue #6's "Mirror approved plugin remotes to a platform-controlled CDN" checklist item is still unchecked, annotated 2026-08-19 as "likely moot under 3B v1's first-party-only trust tier... but never explicitly waived against this item." No formal waiver exists. **If a maintainer wants to close this now:** SRI hashing already covers integrity for the current first-party-only tier; origin allowlisting only becomes necessary if/when third-party remotes are permitted. | Needs a maintainer call — code confirms the gap, not the decision.                                            |
| OQ-2 | Who owns writing the `@platform/plugin-sdk` semver/deprecation policy, and by when?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Filed as issue #433 (assigned to @abmish as the PR #397 implementer) — resolving that issue resolves this OQ. |
| OQ-3 | Still open (confirmed 2026-08-24): `manifest-schema.ts`/`types.ts` define only a single `migrations?: string` field — no down/rollback field or type anywhere in `plugin-sdk`, no lifecycle-service down-migration code found. Nothing has changed since the ADR was written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Needs a maintainer call before third-party plugins are considered.                                            |
| OQ-4 | **Resolved (2026-08-24):** already fixed. `roadmap-tracker.md`'s 3B row now reads 90% (not 100%), explicitly states "no plugin can run backend code (routes/hooks/jobs) yet — only migrations execute," and cross-references #433. No further caveat needed — read Decision #1's language alongside that tracker row, not standalone.                                                                                                                                                                                                                                                                                                                                                                                                                | Confirmed against current `roadmap-tracker.md`.                                                               |

---

## Implementation next steps

1. This ADR requires no code changes by itself — it documents Decisions #1-10 as already shipped
   (PR #397) and formalizes the gaps above, including the corrections from adversarial review, as
   tracked rather than silently accepted or silently overstated.
2. Still open — resolve OQ-2 via issue #433 (remains open as of 2026-08-24).
3. Still open — decide and log OQ-1 explicitly (no formal waiver has been made; see OQ-1's
   updated text above).
4. **Resolved (2026-08-24):** OQ-4 reconciled — `roadmap-tracker.md`'s 3B row already carries the
   90%/route-hook-job-loading-gap caveat this item asked for.
5. Cross-link this ADR from `docs/specs/plugin-system.md`'s header and from issue #6's
   plugin-marketplace-security checklist (already partially reconciled in that issue's 2026-08-19
   comment) — now actionable given `Status: Accepted`, not deferred behind "once accepted" anymore.
