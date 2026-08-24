# Spec: Plugin System (3B)

**Status:** draft
**Author:** Claude Code (session), planning decisions confirmed by @abmish 2026-08-13
**Date:** 2026-08-13
**Decision record:** `docs/decisions/ADR-011-plugin-system.md` (Accepted 2026-08-24) formalizes
the decisions this spec implements, including 2 known gaps (no wrapped DB client/governor limits
wired, no plugin backend-code loader yet — see issue #433) and the current Open Questions.

---

## §C Context

Issue #17 / `docs/roadmap.md` §3B scope the plugin system as the escape hatch for capabilities
the three engines genuinely cannot express — new data models with custom backend logic, new API
routes, new job types, complex frontend beyond what `view_configs`-driven generic views can
render. It is explicitly **not** a way around ADR-004's config-first rule for anything the
engines _can_ already express — that stays seed SQL, always.

3B is technically independent of 3A/3C/3D — no shared schema, no shared runtime. It depends only
on #13 (2B module system), already shipped, which validated the simpler "install = apply config"
model this system extends into "install = register real code."

**Trust-tier decision (locked this session, see below):** v1 ships **first-party only** — the
same call ADR-009 made for connectors. Unlike that decision, which needed no schema change
(policy statement only, since a connector's `callApi()` is already constrained by the SSRF
guard + `allowedHosts`), a plugin can run arbitrary backend code, its own DB migrations, and
register real API routes — a categorically larger blast radius than a connector. This spec
therefore encodes the trust tier as an actual DB-level gate (`plugin_definitions.trust_tier`),
not just a comment, so it cannot be silently widened by an install-flow bug. Reopening it to
third-party is a deliberate future decision (CHECK-constraint change), mirroring how ADR-008's
`scopes_format` discriminator was built as an explicit column specifically so its own future
reopening would be a small, visible change — see `packages/auth/src/scopes.ts` for that
precedent.

**Existing scaffolding this spec builds on:** `@platform/plugin-sdk` already has a real
`PluginManifest`/`PluginPermission`/`SlotRegistration`/`PageRegistration` type stub
(`packages/plugin-sdk/src/types.ts`) — Phase 1 scaffolding, zero consumers yet. No
`plugin_definitions`/`installed_plugins`/`plugin_errors` tables exist in
`packages/db/src/schema/` yet — this is genuinely 0%, matching the tracker.

---

## §R Requirements

**R1 — `plugin_definitions` catalog table.** Platform-wide (no `tenant_id`/RLS — same
"non-tenant-scoped table" class as `connector_definitions`/`modules`, readable by `app_user`,
writable only by `migration_user`/admin-role endpoints). Mirrors `connector_definitions`'s shape:
`id`, `slug` (unique), `name`, `version`, `description`, `iconUrl`, `docsUrl`, `category`.
Adds **`trust_tier text NOT NULL DEFAULT 'first_party' CHECK (trust_tier IN ('first_party'))`**
— a single-value enum today, deliberately shaped so admitting a second tier later is a CHECK
change, not a migration redesign (ADR-008 `scopes_format` precedent). The manifest itself
(`PluginManifest`, permissions, slot/page registrations, `remoteEntry` URL) is **not** duplicated
into columns — same reasoning `connector_definitions` uses for `triggers`/`actions`: it's
declarative data closer to code than to a catalog row, and belongs versioned with the plugin's
own repo, not the DB row.
✓ Inserting a `plugin_definitions` row with `trust_tier = 'third_party'` fails the CHECK
constraint. ✓ `slug` collision on insert fails the unique constraint, not a silent overwrite.

**R2 — `installed_plugins` table.** Tenant-scoped install row: `tenant_id`, `plugin_id` (FK →
`plugin_definitions.id`), `manifest_snapshot jsonb` (the exact `PluginManifest` this tenant
installed, frozen at install time so a later plugin-definition update doesn't retroactively
change what's already running), `version`, `status` (`installing | active | error | disabled`),
timestamps. Standard tenant RLS pair + index on `tenant_id` + composite `(tenant_id, plugin_id)`
unique index.
✓ Tenant A's isolation test cannot read tenant B's `installed_plugins` row via any API surface.
✓ Installing the same `plugin_id` twice for one tenant fails the composite unique constraint.

**R3 — Plugin lifecycle service.** `resolve deps → validate permissions against tenant plan →
run migrations (plugin's own Postgres schema namespace) → register routes/hooks/jobs → activate`.
Each step is transactional where the underlying operation allows it (schema-namespace migration
run, `installed_plugins` status write); a failure at any step leaves `status = 'error'` with the
failure reason recorded, never a half-registered plugin silently reported as active.
**Dependency policy (`PluginManifest.requires`):** a missing required dependency **hard-blocks
install** with a named-dependency error — this service never cascade-installs a dependency on a
tenant's behalf. Simpler to reason about, and consistent with the module system (#13), which
also never auto-installs anything a tenant didn't explicitly request.
✓ Installing a plugin whose `requires` names an uninstalled plugin returns a 4xx naming the
missing dependency; `installed_plugins.status` never reaches `active`.
✓ A migration failure at any step leaves `status = 'error'` with `errorReason` populated, and
`plugin_errors` gets a matching row.

**R4 — Postgres schema namespace isolation.** Each plugin gets a dedicated Postgres schema
(`plugin_<slug>`) at install time. Plugin migrations run only against that schema — never the
platform's own `public` schema — **enforced by grant, not convention**: the role a plugin's
migration runs under has `CREATE`/`USAGE` on `plugin_<slug>` only, the same role-scoping pattern
`app_user` already uses for RLS enforcement elsewhere in this codebase, so a plugin author's
mistake (not just malice) is structurally blocked, not just discouraged. This is the direct
analogue of Salesforce's per-package namespace isolation, and is Core regardless of trust tier:
it's what makes plugin uninstall + data cleanup mechanical (drop the schema) instead of a manual
audit of which tables belong to which plugin. **This solves isolation _between_ plugins — it
does not by itself solve tenant isolation _within_ one plugin's own tables. See R13.**
✓ A migration attempting `CREATE TABLE public.foo` (or any statement outside `plugin_<slug>`)
fails with a Postgres permission error, not a silent write.

**R4 addendum — Plugin code has exactly one DB entry point.** Plugin backend code cannot
`import` `@platform/db` directly — the plugin SDK exposes its own scoped client (wrapping the
same connection, restricted to the plugin's schema + governor limits from R5) as the _only_ DB
handle available to plugin code. This closes the gap where R5's governor limits would otherwise
be trivially bypassable by importing the platform's own unrestricted client instead of the
"wrapped client" R5 describes.
✓ TypeScript build of a plugin fails if it imports `@platform/db` — the plugin-sdk's own
scoped client is the only DB import available in that package's dependency graph.

**R5 — Soft governor limits.** Per-plugin **query timeout** (default 5s) and **max-rows-touched
ceiling (default 10,000 rows per query)** on any query issued through the plugin's DB client
(R4 addendum), enforced at the lifecycle service's call boundary (the wrapped client, not a
Postgres-level `statement_timeout` alone, so the breach is attributable to a specific plugin in
the log line). Separately, **per-plugin job execution timeout (default 30s)** on anything
registered via `PluginManifest.jobs` — a query limit alone doesn't bound a job that loops or
leaks memory without ever issuing a slow query. v1 is **soft** for both: a breach is logged with
`tenantId`+`pluginId`+the offending operation and written to `plugin_errors`, but does **not**
kill the request/job — first-party trust means a breach is far more likely a bug than an attack,
and a hard kill on every timeout would make plugin development miserable during 3B's own
build-out. **This is the item most likely to need revisiting** if/when the trust tier ever opens
up — hard enforcement becomes mandatory the moment a plugin author isn't someone on this team.
✓ A query touching 10,001 rows through the plugin client logs a `governor_limit_breach` row in
`plugin_errors` and still returns its result. ✓ A plugin job running past 30s logs the same
breach kind and is still allowed to finish.

**R6 — Plugin UI integrates without a full page reload or a duplicate framework bundle.**
Chosen implementation: **Module Federation**, justified specifically by the first-party-only
decision — shared JS runtime, richer UI integration, acceptable risk because every live plugin
was authored by the platform team. **If the trust tier is ever reopened, this implementation
choice must be revisited too** — Module Federation's shared-runtime model is a poor fit for
genuinely untrusted code (a bad plugin can affect host memory/state); the alternative considered
and deferred is iframe + `postMessage` isolation, which trades UI richness for real fault
isolation and would be the right default the day a non-first-party plugin can install.
✓ Navigating into a plugin-registered page does not trigger a full browser page reload.
**Implementation note (Phase 3):** `@module-federation/vite` is the Vite-team/VoidZero-recommended
plugin (source-driven-development: https://github.com/module-federation/vite, which documents an
explicit migration path away from the older `@originjs/vite-plugin-federation`) — but admin-ui
only ever _consumes_ a plugin's remote dynamically at runtime (the remoteEntry URL is only known
per-tenant, from that tenant's installed plugin row, never at build time), so no `vite.config.ts`
change was needed at all. `apps/admin-ui/src/lib/plugin-remote-loader.ts` uses the plain
`@module-federation/runtime` package's `registerRemotes`/`loadRemote`
(https://module-federation.io/guide/runtime/runtime-api) directly — verified against that
package's real installed `.d.ts` and a real production `vite build`, since the plugin the host
would actually load doesn't exist yet to test end-to-end (see R12's note on the same gap).

**R7 — `<Slot>` component with per-slot, per-plugin error boundaries.** A plugin UI failure
inside one slot cannot propagate to the host or to other slots. Reads `SlotRegistration[]` from
the installed plugin's manifest snapshot (R2).
✓ A slot's component throwing during render leaves every other slot on the page functional and
writes a `runtime_exception` row to `plugin_errors` (R8).
**Implementation note (Phase 3):** `apps/admin-ui/src/components/plugin-slot.tsx`'s `<PluginSlot>`
deliberately does **not** use `React.lazy`/`Suspense` — React's own rule is that a lazy
component's loader must be defined at module scope, not re-created per render, which conflicts
with a loader that has to vary per (pluginSlug, slotName) pair. Uses a manual
load-then-render-or-throw pattern instead (store an async failure in state, re-throw it
synchronously on the next render so the error boundary catches it). The ✓ criterion's "writes a
`runtime_exception` row" needed a real endpoint that didn't exist yet —
`POST /plugins/:slug/errors` + `reportPluginRuntimeError` (added this phase) is what the error
boundary actually calls.

**R8 — Plugin error isolation.** New `plugin_errors` table (tenant-scoped, RLS) — any lifecycle
failure, governor-limit breach (R5), or runtime exception surfaced by a slot's error boundary
(R7) writes here instead of crashing the platform process.
✓ Every failure mode named in R3/R5/R7 produces exactly one `plugin_errors` row with a `kind`
matching that failure mode — never an unhandled process-level exception.

**R9 — Plugin uninstall.** Deregister routes/hooks/jobs, flip `installed_plugins.status`, and
**delete that tenant's rows from every table in the plugin's schema** (the same tenant-scoped
delete helper R13's tenant-purge extension needs — built once, used by both) unless the caller
passes `?retainData=true`. **Corrected during Phase 1 implementation:** the schema itself
(`plugin_<slug>`) is _never_ dropped by a single tenant's uninstall — R4's schema is shared by
every tenant with that plugin installed (R2), so dropping it on one tenant's uninstall would
destroy every other tenant's data too. Schema-level teardown (only safe once _zero_ tenants have
it installed) is not built in v1 — an empty, unused `plugin_<slug>` schema is cheap to leave
around, and no flow exists yet to fully retire a `plugin_definitions` row.
✓ Uninstall with no query param deletes that tenant's rows from every table in `plugin_<slug>`
and flips `status` to a terminal state; a second tenant with the same plugin still installed is
completely unaffected. ✓ Uninstall with `retainData=true` flips status without deleting any row.

**R10 — `@platform/plugin-sdk` versioning.** The package already exists with real types (see
§C) — this spec's job is a version/deprecation contract (semver, a documented breaking-change
policy) _before_ a second real consumer (an actual plugin) is built against it, not a type
rewrite. `platformVersion` on `PluginManifest` (already present) is the compatibility check the
lifecycle service (R3) validates at install time.
✓ Installing a plugin whose `platformVersion` doesn't satisfy the running platform's version
range is rejected before any migration runs.

**R11 — Plugin health dashboard (admin-ui).** Reads `installed_plugins.status` +
`plugin_errors` per tenant. Reuses the generic list/detail component pattern (`<EntityList>`
family) rather than a bespoke page, consistent with 2C's "one generic component serves every
module" precedent — a plugin install row is just another entity-shaped thing to list.
✓ An admin can see a specific plugin's `plugin_errors` rows for their tenant without a
bespoke query — the generic list view, filtered.

**R12 — SRI hash validation for `remoteEntry.js`.** Cheap even under first-party trust (verifies
the exact file a browser loaded matches what was registered — catches CDN/build-pipeline
tampering, not just malicious authorship) — kept as Core rather than downgraded to Important
despite the trust-tier decision, since the cost of doing it now is low and the alternative is
retrofitting it onto every already-installed plugin later.
✓ Serving a `remoteEntry.js` byte-mismatched against its registered hash fails to load with a
visible error, not a silent execution of altered code.
**Implementation note (Phase 3):** a naive implementation — fetch once to verify the hash, then
let `registerRemotes`/`loadRemote` fetch the URL again to actually load it — has a TOCTOU gap:
the second fetch is never re-verified, so a CDN swap between the two requests defeats the check
entirely. `plugin-remote-loader.ts`'s `loadPluginRemote` closes this the same way this codebase's
connector-sdk DNS-rebinding fix already does elsewhere (verify once, pin the exact verified
resource, never re-resolve): the verified bytes are wrapped in a same-origin `Blob` and that
`blob:` URL — never the original remote URL — is what gets registered with the federation
runtime.

**R13 — Tenant isolation within a plugin's own tables.** R4's `plugin_<slug>` schema isolates
plugins _from each other_ — it does not isolate one tenant's data from another's _within_ a
single plugin's tables, since many tenants can install the same plugin (R2). Any table a plugin
migration creates that stores tenant-scoped data **must** carry `tenant_id NOT NULL` + the
platform's standard RLS pair — the exact same two-layer rule `security.md` already makes
non-negotiable for platform tables (explicit `tenant_id` filter + RLS, not either alone). R3's
"validate" lifecycle step includes a static check that a plugin's migration SQL creating a table
without both is rejected before it ever runs, rather than trusting every first-party author to
remember. **Tenant deletion**: `apps/worker/src/tenant-purge.ts` already drives tenant-deletion
cascade for platform tables — this spec requires it to also enumerate every installed plugin's
schema for that tenant and delete `WHERE tenant_id = ?` there too, not just handle the
plugin-uninstall path (R9). A tenant being deleted is not the same event as a tenant uninstalling
one plugin, and both must fully remove that tenant's data.
✓ A plugin migration creating a table with no `tenant_id` column fails install-time validation
before the migration executes. ✓ Deleting a tenant via the existing purge flow leaves zero rows
matching that `tenant_id` in any installed plugin's schema, verified by an isolation test that
installs a plugin, writes data, deletes the tenant, and checks every plugin schema directly.

---

## §NR Non-Requirements (explicitly out of scope for this spec)

- **Third-party / open marketplace enrollment.** Deferred behind the trust-tier decision above.
  Revisiting it needs, at minimum: a review/vetting pipeline, hard (not soft) governor limits,
  and almost certainly R6's Module Federation choice replaced or supplemented with iframe
  isolation for anything not first-party. Not designed here — flagged as the named trigger for a
  follow-up spec.
- **Cross-plugin communication.** No plugin-to-plugin RPC or shared state beyond what the slot
  registry (R7) itself exposes. A plugin needing another plugin's data goes through the entity
  engine's relations API, same as any other consumer — no special-cased plugin bus.
- **Plugin billing/usage metering.** Resource consumption by a plugin (DB rows, job time) is
  **not** wired into a `tenant_usage` table by this spec — that table's shape is being designed
  jointly with 3C/3D (see roadmap-tracker.md's 3B/3C/3D coordination note) and plugins are a
  future consumer of it, not a co-designer of its schema.
- **Plugin marketplace UI (browse/discover).** R11's health dashboard is _for installed
  plugins_, not a discovery/browse surface — that only makes sense once more than "a handful of
  first-party plugins" exist to browse.

---

## §I Interfaces

```typescript
// packages/db/src/schema/platform.ts (new tables)

export const pluginDefinitions = pgTable("plugin_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  iconUrl: text("icon_url"),
  docsUrl: text("docs_url"),
  category: text("category").notNull(),
  // Single-value enum today by design — see §C. Widening this is the explicit
  // future decision point, not an oversight.
  trustTier: text("trust_tier").notNull().default("first_party"), // CHECK (trust_tier IN ('first_party'))
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginDefinitions.id),
    manifestSnapshot: jsonb("manifest_snapshot").notNull(), // frozen PluginManifest at install time
    version: text("version").notNull(),
    status: text("status").notNull().default("installing"), // installing | active | error | disabled
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantPluginUnique: uniqueIndex("installed_plugins_tenant_plugin_idx").on(
      t.tenantId,
      t.pluginId,
    ),
  }),
);

export const pluginErrors = pgTable("plugin_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  pluginId: uuid("plugin_id")
    .notNull()
    .references(() => pluginDefinitions.id),
  kind: text("kind").notNull(), // lifecycle_failure | governor_limit_breach | runtime_exception
  detail: jsonb("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

```typescript
// packages/plugin-sdk/src/types.ts — already exists, unchanged by this spec:
// PluginManifest, PluginPermission, SlotRegistration, PageRegistration.
// This spec adds no new SDK types; R10's job is a version-compat policy, not a type change.
```

```typescript
// apps/api/src/routes/plugins/index.ts (new) — mounted at app.route("/plugins", ...)
// Self-service, same shape as apps/api/src/routes/modules/index.ts (a tenant's own
// admin installing a module for their tenant) — corrected during Phase 2
// implementation from an earlier /admin/tenants/:id/... sketch, which mirrored the
// wrong precedent (platform-superadmin tenant-lifecycle routes, admin/tenants.ts).
// Installing a plugin is a tenant's own choice about their own tenant, not a
// platform operator acting on an arbitrary tenant by :id.
// All routes: requireAuth() + requireRole("admin"); tenantId comes from auth.tenantId.
GET  /plugins                          -> installed + available, for R11
POST /plugins/:slug/install            -> runs the lifecycle service (R3)
POST /plugins/:slug/uninstall          -> uninstall (R9), json body { retainData?: boolean }
```

## §V Invariants

<!-- First pass — no bugs to promote from yet, seeded directly from this spec's own review. -->

- No plugin's migration or runtime code ever writes outside its own `plugin_<slug>` schema
  (R4) — enforced by DB grant, not reviewed by convention.
- Every plugin-authored table storing tenant data carries `tenant_id` + the standard RLS pair
  (R13) — no exception, first-party or not.
- `plugin_definitions.trust_tier` widens only via an explicit, reviewed migration — never
  silently, never as a side effect of an unrelated change.

## §T Tasks

To be expanded via `/spec-tasks` once this spec is reviewed — see
`docs/specs/plugin-system-tasks.md` when generated.

## §B Bugs / Backprop Log

(empty — pre-implementation)
