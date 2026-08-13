/**
 * Plugin lifecycle service (3B Phase 1, docs/specs/plugin-system.md R3).
 *
 * install: resolve deps (hard-block) -> validate (manifest schema, platformVersion
 * compat, R13's tenant_id+RLS migration lint) -> run migration -> register
 * (installed_plugins row, status=active).
 *
 * No route/hook/job registration yet — that lands in Phase 2 (T6) once real HTTP
 * routes exist. This is the service layer only, matching module-service.ts's
 * split (ModuleService is called by tenant-lifecycle.ts and by admin routes,
 * neither of which this file wires up yet).
 */

import { eq, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  runPluginMigration,
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
      | "INVALID_MANIFEST"
      | "MISSING_DEPENDENCY"
      | "PLATFORM_VERSION_INCOMPATIBLE"
      | "MIGRATION_VALIDATION_FAILED"
      | "MIGRATION_FAILED",
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "PluginLifecycleError";
  }
}

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
