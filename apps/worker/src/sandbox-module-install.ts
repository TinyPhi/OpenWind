/**
 * sandbox-module-install.ts
 *
 * T9 (docs/specs/multi-org-sandbox.md Phase 2) — installs all 7 core modules' seed SQL
 * (entity types, workflows, view configs, and -- for the modules T10 added rules to --
 * automation rules) into a freshly-provisioned sandbox tenant, before
 * sandbox-module-data-seed.ts seeds actual records into those workflows.
 *
 * This duplicates apps/api/src/services/module-service.ts's ModuleService.installModule
 * (the seed-file-running core of it; the workflowName-rename option is omitted since
 * sandboxes always use each module's canonical name) rather than importing it --
 * apps/worker cannot import from apps/api (no such import exists anywhere in this
 * codebase; packages/*'s dependency rule plus queues.ts's own comment both confirm this
 * is a hard boundary, not an oversight). This mirrors this file's sibling,
 * sandbox-provisioning-worker.ts, which already duplicates apps/api/src/lib/
 * tenant-lifecycle.ts's tenant-insert logic for the identical reason.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  executeRawInTenantContext,
  withTenantContext,
  modules,
  tenants,
  workflows,
  entityTypes,
} from "@platform/db";
import { logger } from "@platform/logger";

function getWorkspaceRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // fallback
}

async function installModuleForSandbox(
  tenantId: string,
  slug: string,
  moduleId: string,
  moduleName: string,
): Promise<void> {
  const seedDir = join(getWorkspaceRoot(), "modules", slug, "seed");
  if (!existsSync(seedDir)) {
    logger.warn(
      { slug, seedDir },
      "sandbox module install: no seed directory found",
    );
    return;
  }

  const files = await fs.readdir(seedDir);
  const sqlFiles = files
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of sqlFiles) {
    const filePath = join(seedDir, file);
    const sqlContent = await fs.readFile(filePath, "utf8");
    const processedSql = sqlContent
      .replaceAll("'{TENANT_ID}'", `'${tenantId}'::uuid`)
      .replaceAll("'{MODULE_ID}'", `'${moduleId}'::uuid`)
      .replaceAll("{WORKFLOW_NAME}", moduleName);

    if (processedSql.trim().length > 0) {
      await executeRawInTenantContext(tenantId, processedSql);
    }
  }
}

/**
 * Installs every `category = 'core'` module for a sandbox tenant, same ADR-005
 * all-or-nothing core-module set real tenants get via ModuleService.installCoreModules.
 * Each module is attempted independently -- one module's failure doesn't block the rest,
 * same reasoning as the apps/api counterpart (unrelated business domains, idempotent seed
 * SQL since #161).
 */
/**
 * The sandbox's admin owns each module's seeded workflows, so a ticket that names nobody has
 * someone to fall back to (docs/specs/mandatory-ticket-fields.md R7). Only where no owner is
 * set yet, the same rule as ModuleService.installModule in apps/api.
 */
async function recordWorkflowOwner(
  tenantId: string,
  moduleId: string,
  ownerId: string,
): Promise<void> {
  await withTenantContext(tenantId, (tx) =>
    tx
      .update(workflows)
      .set({ createdBy: ownerId })
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          isNull(workflows.createdBy),
          inArray(
            workflows.entityTypeId,
            tx
              .select({ id: entityTypes.id })
              .from(entityTypes)
              .where(
                and(
                  eq(entityTypes.tenantId, tenantId),
                  eq(entityTypes.moduleId, moduleId),
                ),
              ),
          ),
        ),
      ),
  );
}

export async function installCoreModulesForSandbox(
  tenantId: string,
  ownerId?: string,
): Promise<{
  succeeded: string[];
  failed: { slug: string; error: string }[];
}> {
  const coreModules = await db
    .select({ id: modules.id, slug: modules.slug, name: modules.name })
    .from(modules)
    .where(eq(modules.category, "core"));

  const succeeded: string[] = [];
  const failed: { slug: string; error: string }[] = [];

  for (const { id, slug, name } of coreModules) {
    try {
      await installModuleForSandbox(tenantId, slug, id, name);
      if (ownerId) await recordWorkflowOwner(tenantId, id, ownerId);
      succeeded.push(slug);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, tenantId, slug },
        "sandbox module install: module failed — continuing with remaining core modules",
      );
      failed.push({ slug, error: message });
    }
  }

  if (succeeded.length > 0) {
    const [tenantRow] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const existingConfig = (tenantRow?.config ?? {}) as Record<string, unknown>;
    await db
      .update(tenants)
      .set({
        config: { ...existingConfig, installed_modules: succeeded },
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));
  }

  return { succeeded, failed };
}
