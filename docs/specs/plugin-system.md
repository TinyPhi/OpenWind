# Spec: Plugin System (3B)

**Status:** draft
**Author:** Claude Code (session), planning decisions confirmed by @abmish 2026-08-13
**Date:** 2026-08-13

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

**R2 — `installed_plugins` table.** Tenant-scoped install row: `tenant_id`, `plugin_id` (FK →
`plugin_definitions.id`), `manifest_snapshot jsonb` (the exact `PluginManifest` this tenant
installed, frozen at install time so a later plugin-definition update doesn't retroactively
change what's already running), `version`, `status` (`installing | active | error | disabled`),
timestamps. Standard tenant RLS pair + index on `tenant_id` + composite `(tenant_id, plugin_id)`
unique index.

**R3 — Plugin lifecycle service.** `resolve deps → validate permissions against tenant plan →
run migrations (plugin's own Postgres schema namespace) → register routes/hooks/jobs → activate`.
Each step is transactional where the underlying operation allows it (schema-namespace migration
run, `installed_plugins` status write); a failure at any step leaves `status = 'error'` with the
failure reason recorded, never a half-registered plugin silently reported as active.

**R4 — Postgres schema namespace isolation.** Each plugin gets a dedicated Postgres schema
(`plugin_<slug>`) at install time. Plugin migrations run only against that schema — never the
platform's own `public` schema. This is the direct analogue of Salesforce's per-package
namespace isolation, and is Core regardless of trust tier: it's what makes plugin uninstall +
data cleanup mechanical (drop the schema) instead of a manual audit of which tables belong to
which plugin.

**R5 — Soft governor limits.** Per-plugin **query timeout** (default 5s) and **max-rows-touched**
ceiling on any query issued through the plugin's DB client, enforced at the lifecycle service's
call boundary (a wrapped client, not a Postgres-level `statement_timeout` alone, so the breach is
attributable to a specific plugin in the log line). v1 is **soft**: a breach is logged with
`tenantId`+`pluginId`+the offending operation and written to `plugin_errors`, but does **not**
kill the request — first-party trust means a breach is far more likely a bug than an attack, and
a hard kill on every timeout would make plugin development miserable during 3B's own build-out.
**This is the item most likely to need revisiting** if/when the trust tier ever opens up — hard
enforcement becomes mandatory the moment a plugin author isn't someone on this team.

**R6 — Module Federation frontend host.** Justified specifically by the first-party-only
decision: shared JS runtime, richer UI integration, acceptable risk because every live plugin was
authored by the platform team. **If the trust tier is ever reopened, this decision must be
revisited too** — Module Federation's shared-runtime model is a poor fit for genuinely untrusted
code (a bad plugin can affect host memory/state); the alternative considered and deferred is
iframe + `postMessage` isolation, which trades UI richness for real fault isolation and would be
the right default the day a non-first-party plugin can install.

**R7 — `<Slot>` component with per-slot, per-plugin error boundaries.** A plugin UI failure
inside one slot cannot propagate to the host or to other slots. Reads `SlotRegistration[]` from
the installed plugin's manifest snapshot (R2).

**R8 — Plugin error isolation.** New `plugin_errors` table (tenant-scoped, RLS) — any lifecycle
failure, governor-limit breach (R5), or runtime exception surfaced by a slot's error boundary
(R7) writes here instead of crashing the platform process.

**R9 — Plugin uninstall.** Deregister routes/hooks/jobs, flip `installed_plugins.status`, and
**drop the plugin's Postgres schema** (R4) unless the tenant explicitly requests data retention
— same retain-by-default posture the module system (#13) already uses for its own uninstall.

**R10 — `@platform/plugin-sdk` versioning.** The package already exists with real types (see
§C) — this spec's job is a version/deprecation contract (semver, a documented breaking-change
policy) _before_ a second real consumer (an actual plugin) is built against it, not a type
rewrite. `platformVersion` on `PluginManifest` (already present) is the compatibility check the
lifecycle service (R3) validates at install time.

**R11 — Plugin health dashboard (admin-ui).** Reads `installed_plugins.status` +
`plugin_errors` per tenant. Reuses the generic list/detail component pattern (`<EntityList>`
family) rather than a bespoke page, consistent with 2C's "one generic component serves every
module" precedent — a plugin install row is just another entity-shaped thing to list.

**R12 — SRI hash validation for `remoteEntry.js`.** Cheap even under first-party trust (verifies
the exact file a browser loaded matches what was registered — catches CDN/build-pipeline
tampering, not just malicious authorship) — kept as Core rather than downgraded to Important
despite the trust-tier decision, since the cost of doing it now is low and the alternative is
retrofitting it onto every already-installed plugin later.

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
// apps/api/src/routes/admin/plugins.ts (new)
POST   /admin/tenants/:id/plugins/:pluginSlug/install    -> runs the lifecycle service (R3)
DELETE /admin/tenants/:id/plugins/:pluginSlug             -> uninstall (R9)
GET    /admin/tenants/:id/plugins                         -> installed_plugins + plugin_errors, for R11
```

## §T Tasks

To be expanded via `/spec-tasks` once this spec is reviewed — see
`docs/specs/plugin-system-tasks.md` when generated.

## §B Bugs / Backprop Log

(empty — pre-implementation)
