/**
 * Plugin lifecycle service (3B, docs/specs/plugin-system.md R3/R9).
 *
 * install: resolve deps (hard-block) -> validate (manifest schema, platformVersion
 * compat, R13's tenant_id+RLS migration lint) -> run migration -> register
 * (installed_plugins row, status=active).
 *
 * uninstall (R9): flip installed_plugins.status to 'disabled', and unless
 * retainData is true, delete this tenant's rows from every table in the
 * plugin's schema — never drop the schema itself, which is shared by every
 * tenant with that plugin installed.
 *
 * No route/hook/job registration of the plugin's own routes/hooks/jobs yet —
 * PluginManifest.routes/hooks/jobs describe what a real installed plugin
 * would register, but no mechanism exists yet to actually load and mount
 * that code (that's follow-on work once a real first-party plugin exists to
 * validate the shape against, matching this spec's own scope note that this
 * phase is data/lifecycle only).
 */

import { eq, and, sql as drizzleSql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  runPluginMigration,
  purgeTenantDataFromPluginSchema,
  pluginDefinitions,
  installedPlugins,
  pluginErrors,
} from "@platform/db";
import { logger } from "@platform/logger";
import {
  PluginManifestSchema,
  isPlatformVersionCompatible,
  type ValidatedPluginManifest,
} from "@platform/plugin-sdk";
import { lintPluginMigration } from "./plugin-migration-lint.js";

const CURRENT_PLATFORM_VERSION = "1.0.0";

export class PluginLifecycleError extends Error {
  constructor(
    public readonly code:
      | "PLUGIN_NOT_FOUND"
      | "ALREADY_INSTALLED"
      | "NOT_INSTALLED"
      | "INVALID_MANIFEST"
      | "MISSING_DEPENDENCY"
      | "PLATFORM_VERSION_INCOMPATIBLE"
      | "MIGRATION_VALIDATION_FAILED"
      | "MIGRATION_FAILED"
      | "UNINSTALL_FAILED",
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "PluginLifecycleError";
  }
}

/** Route layer (T6) maps these to HTTP status codes — see plugins/index.ts. */
export const PLUGIN_LIFECYCLE_ERROR_STATUS: Record<
  PluginLifecycleError["code"],
  number
> = {
  PLUGIN_NOT_FOUND: 404,
  NOT_INSTALLED: 404,
  ALREADY_INSTALLED: 409,
  INVALID_MANIFEST: 422,
  MISSING_DEPENDENCY: 422,
  PLATFORM_VERSION_INCOMPATIBLE: 422,
  MIGRATION_VALIDATION_FAILED: 422,
  MIGRATION_FAILED: 500,
  UNINSTALL_FAILED: 500,
};

async function writeLifecycleError(
  tenantId: string,
  pluginId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenantContext(tenantId, (tx) =>
      tx.insert(pluginErrors).values({
        tenantId,
        pluginId,
        kind: "lifecycle_failure",
        detail,
      }),
    );
  } catch (err: unknown) {
    // Logging the failure to record a failure must never itself throw and mask
    // the original error the caller is already about to raise.
    logger.error(
      { tenantId, pluginId, err: String(err) },
      "plugin-lifecycle: failed to write plugin_errors row",
    );
  }
}

export interface InstallPluginOptions {
  manifest: unknown;
  migrationSql: string;
}

/**
 * Installs a plugin for a tenant. `manifest`/`migrationSql` are passed in by
 * the caller rather than read from a filesystem/registry convention — no such
 * convention exists yet (that's #368/marketplace-adjacent, not built). The
 * caller resolves those from wherever a real plugin's bundle eventually lives.
 */
export async function installPlugin(
  tenantId: string,
  pluginSlug: string,
  opts: InstallPluginOptions,
): Promise<{ installedPluginId: string }> {
  const [plugin] = await db
    .select()
    .from(pluginDefinitions)
    .where(eq(pluginDefinitions.slug, pluginSlug))
    .limit(1);

  if (!plugin) {
    throw new PluginLifecycleError("PLUGIN_NOT_FOUND", { pluginSlug });
  }

  const [existing] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ id: installedPlugins.id })
      .from(installedPlugins)
      .where(
        and(
          eq(installedPlugins.tenantId, tenantId),
          eq(installedPlugins.pluginId, plugin.id),
        ),
      )
      .limit(1),
  );
  if (existing) {
    throw new PluginLifecycleError("ALREADY_INSTALLED", {
      tenantId,
      pluginSlug,
    });
  }

  // Validate: manifest structure (types derive from Zod, never the reverse —
  // applied to plugin manifests same as everything else).
  const parsedManifest = PluginManifestSchema.safeParse(opts.manifest);
  if (!parsedManifest.success) {
    throw new PluginLifecycleError("INVALID_MANIFEST", {
      pluginSlug,
      issues: parsedManifest.error.issues,
    });
  }
  const manifest: ValidatedPluginManifest = parsedManifest.data;

  // Dependency policy (R3): hard-block on a missing declared dependency, never
  // cascade-install. "Installed" here means active for this tenant already —
  // a dependency the tenant hasn't installed at all is the missing case.
  if (manifest.requires && manifest.requires.length > 0) {
    const installedSlugs = await withTenantContext(tenantId, (tx) =>
      tx
        .select({ slug: pluginDefinitions.slug })
        .from(installedPlugins)
        .innerJoin(
          pluginDefinitions,
          eq(installedPlugins.pluginId, pluginDefinitions.id),
        )
        .where(eq(installedPlugins.tenantId, tenantId)),
    );
    const installedSet = new Set(installedSlugs.map((r) => r.slug));
    const missing = manifest.requires.filter((dep) => !installedSet.has(dep));
    if (missing.length > 0) {
      throw new PluginLifecycleError("MISSING_DEPENDENCY", {
        pluginSlug,
        missing,
      });
    }
  }

  // Validate: platformVersion compatibility.
  if (
    !isPlatformVersionCompatible(
      manifest.platformVersion,
      CURRENT_PLATFORM_VERSION,
    )
  ) {
    throw new PluginLifecycleError("PLATFORM_VERSION_INCOMPATIBLE", {
      pluginSlug,
      required: manifest.platformVersion,
      current: CURRENT_PLATFORM_VERSION,
    });
  }

  // Validate: R13's static tenant_id+RLS check on the plugin's own migration SQL.
  const lint = lintPluginMigration(opts.migrationSql);
  if (!lint.ok) {
    throw new PluginLifecycleError("MIGRATION_VALIDATION_FAILED", {
      pluginSlug,
      violations: lint.violations,
    });
  }

  // Run the migration (its own transaction — see runPluginMigration's own
  // comment for why this doesn't share a transaction with the write below).
  try {
    await runPluginMigration(pluginSlug, opts.migrationSql);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await writeLifecycleError(tenantId, plugin.id, {
      stage: "run_migration",
      error: message,
    });
    throw new PluginLifecycleError("MIGRATION_FAILED", {
      pluginSlug,
      error: message,
    });
  }

  const [row] = await withTenantContext(tenantId, (tx) =>
    tx
      .insert(installedPlugins)
      .values({
        tenantId,
        pluginId: plugin.id,
        manifestSnapshot: manifest,
        version: manifest.version,
        status: "active",
      })
      .returning({ id: installedPlugins.id }),
  );

  if (!row) {
    // The migration already succeeded and is not rolled back here (see
    // runPluginMigration's comment on the compensating-design precedent) — a
    // retried install is safe: create_plugin_schema is idempotent, and this
    // insert will succeed on retry once whatever blocked it is resolved.
    await writeLifecycleError(tenantId, plugin.id, {
      stage: "register",
      error: "installed_plugins insert returned no row",
    });
    throw new PluginLifecycleError("MIGRATION_FAILED", {
      pluginSlug,
      stage: "register",
    });
  }

  logger.info(
    { tenantId, pluginSlug, installedPluginId: row.id },
    "plugin-lifecycle: plugin installed",
  );

  return { installedPluginId: row.id };
}

/**
 * Uninstalls a plugin for one tenant (R9). Flips the tenant's installed_plugins
 * row to 'disabled' and, unless retainData is true, deletes that tenant's rows
 * from every table in the plugin's schema — never the schema itself, which
 * other tenants with the same plugin installed still depend on.
 */
export async function uninstallPlugin(
  tenantId: string,
  pluginSlug: string,
  opts: { retainData?: boolean } = {},
): Promise<void> {
  const [plugin] = await db
    .select()
    .from(pluginDefinitions)
    .where(eq(pluginDefinitions.slug, pluginSlug))
    .limit(1);

  if (!plugin) {
    throw new PluginLifecycleError("PLUGIN_NOT_FOUND", { pluginSlug });
  }

  const [installed] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ id: installedPlugins.id, status: installedPlugins.status })
      .from(installedPlugins)
      .where(
        and(
          eq(installedPlugins.tenantId, tenantId),
          eq(installedPlugins.pluginId, plugin.id),
        ),
      )
      .limit(1),
  );

  if (!installed) {
    throw new PluginLifecycleError("NOT_INSTALLED", { tenantId, pluginSlug });
  }

  if (!opts.retainData) {
    try {
      await purgeTenantDataFromPluginSchema(tenantId, pluginSlug);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await writeLifecycleError(tenantId, plugin.id, {
        stage: "uninstall_purge",
        error: message,
      });
      throw new PluginLifecycleError("UNINSTALL_FAILED", {
        pluginSlug,
        error: message,
      });
    }
  }

  await withTenantContext(tenantId, (tx) =>
    tx
      .update(installedPlugins)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(installedPlugins.id, installed.id)),
  );

  logger.info(
    { tenantId, pluginSlug, retainData: !!opts.retainData },
    "plugin-lifecycle: plugin uninstalled",
  );
}

export interface PluginListEntry {
  slug: string;
  name: string;
  version: string;
  category: string;
  installed: boolean;
  status: "installing" | "active" | "error" | "disabled" | null;
  errorCount: number;
}

/**
 * Lists every catalog plugin, annotated with this tenant's install status and
 * error count (R11's health dashboard reads this — "installed_plugins.status +
 * plugin_errors per tenant", reusing the generic list view rather than a
 * bespoke query per plugin).
 */
export async function listPluginsForTenant(
  tenantId: string,
): Promise<PluginListEntry[]> {
  const catalog = await db.select().from(pluginDefinitions);

  const installedRows = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        pluginId: installedPlugins.pluginId,
        status: installedPlugins.status,
      })
      .from(installedPlugins)
      .where(eq(installedPlugins.tenantId, tenantId)),
  );
  const installedByPluginId = new Map(
    installedRows.map((r) => [r.pluginId, r.status]),
  );

  const errorCounts = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        pluginId: pluginErrors.pluginId,
        count: drizzleSql<number>`count(*)`.mapWith(Number),
      })
      .from(pluginErrors)
      .where(eq(pluginErrors.tenantId, tenantId))
      .groupBy(pluginErrors.pluginId),
  );
  const errorCountByPluginId = new Map(
    errorCounts.map((r) => [r.pluginId, r.count]),
  );

  return catalog.map((plugin) => ({
    slug: plugin.slug,
    name: plugin.name,
    version: plugin.version,
    category: plugin.category,
    installed: installedByPluginId.has(plugin.id),
    status:
      (installedByPluginId.get(plugin.id) as PluginListEntry["status"]) ?? null,
    errorCount: errorCountByPluginId.get(plugin.id) ?? 0,
  }));
}

/**
 * Records a client-side plugin failure (R7 — a slot's error boundary catching
 * a plugin UI exception) as a `runtime_exception` row, same table Phase 1's
 * server-side failures (R3/R5) already write to. `detail` is caller-supplied
 * (an error message + component stack from the browser) — bounded to a
 * reasonable size by the route layer's Zod schema, not here.
 */
export async function reportPluginRuntimeError(
  tenantId: string,
  pluginSlug: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const [plugin] = await db
    .select({ id: pluginDefinitions.id })
    .from(pluginDefinitions)
    .where(eq(pluginDefinitions.slug, pluginSlug))
    .limit(1);

  if (!plugin) {
    throw new PluginLifecycleError("PLUGIN_NOT_FOUND", { pluginSlug });
  }

  // Review finding (PR #397, PrabhuVijit, L-errors): previously any
  // authenticated user could write a plugin_errors row for any catalog slug,
  // even one their own tenant never installed — this only checked the
  // catalog, not this tenant's installed_plugins row.
  const [installed] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ id: installedPlugins.id })
      .from(installedPlugins)
      .where(
        and(
          eq(installedPlugins.tenantId, tenantId),
          eq(installedPlugins.pluginId, plugin.id),
        ),
      )
      .limit(1),
  );
  if (!installed) {
    throw new PluginLifecycleError("NOT_INSTALLED", { tenantId, pluginSlug });
  }

  await withTenantContext(tenantId, (tx) =>
    tx.insert(pluginErrors).values({
      tenantId,
      pluginId: plugin.id,
      kind: "runtime_exception",
      detail,
    }),
  );
}
