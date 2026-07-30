import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  executeRawInTenantContext,
  modules,
  tenants,
  workflows,
  entityTypes,
} from "@platform/db";
import { logger } from "@platform/logger";

// Allowlist for module slugs — prevents path traversal via slug param
const SLUG_RE = /^[a-z0-9-]+$/;

export function getWorkspaceRoot(): string {
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

export class ModuleService {
  /**
   * seedRegistry - Populates default standard modules into the database
   */
  static async seedRegistry(): Promise<void> {
    const standardModules = [
      {
        slug: "helpdesk",
        name: "Helpdesk",
        description:
          "Support ticket management with priority, SLA, and category tracking",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "crm",
        name: "CRM",
        description: "Sales pipeline and deal tracking from lead to close",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "hrms",
        name: "HRMS",
        description: "Leave request and employee workflow management",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "reimbursements",
        name: "Reimbursements",
        description: "Expense claim submission, approval, and payment tracking",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "projects",
        name: "Projects",
        description:
          "Task and project tracking with backlog, sprint, and review stages",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "invoicing",
        name: "Invoicing",
        description:
          "Invoice lifecycle from draft through sent, viewed, to paid",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "procurement",
        name: "Procurement",
        description:
          "Purchase order requests, approvals, and delivery tracking",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "tender",
        name: "Tender Management",
        description:
          "Tender lifecycle from draft through BOQ, isolated costing review, and submission",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "nsi-amendment",
        name: "NSI Amendment Request",
        description:
          "Non-Schedule Item amendment request lifecycle from internal review through Railway submission to approval",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
      {
        slug: "sales-pipeline",
        name: "Sales Pipeline & Enquiry Tracking",
        description:
          "Sales enquiry tracking from costing through internal approvals, quotation, and order outcome",
        version: "0.0.1",
        isSystem: false,
        minPlan: "standard",
      },
    ];

    logger.info({}, "Seeding modules registry...");
    for (const mod of standardModules) {
      await db
        .insert(modules)
        .values({
          slug: mod.slug,
          name: mod.name,
          description: mod.description,
          version: mod.version,
          isSystem: mod.isSystem,
          minPlan: mod.minPlan,
        })
        .onConflictDoUpdate({
          target: modules.slug,
          set: {
            name: mod.name,
            description: mod.description,
            version: mod.version,
            updatedAt: new Date(),
          },
        });
    }
    logger.info({}, "Modules registry seeded.");
  }

  /**
   * listModules - Returns all registered modules with installation status for a tenant.
   * Auto-seeds the registry on first call or after a reset so templates always appear.
   */
  static async listModules(
    tenantId: string,
    includeHidden: boolean,
  ): Promise<Record<string, unknown>[]> {
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    let allModules = await db.select().from(modules);

    // Auto-seed if the registry is empty (first boot or after a data reset)
    if (allModules.length === 0) {
      await ModuleService.seedRegistry();
      allModules = await db.select().from(modules);
    }
    const installedList = (
      tenant?.config as Record<string, unknown> | undefined
    )?.installed_modules;
    const installed = Array.isArray(installedList)
      ? (installedList as string[])
      : [];

    // Default view (Templates page, everyone including admin) only shows
    // globally-visible templates. `includeHidden` is only ever true when the
    // route layer has already verified the caller is admin AND explicitly
    // asked to see hidden ones too (the Settings management view) — plain
    // browsing never bypasses the filter, admin included.
    const visibleModules = includeHidden
      ? allModules
      : allModules.filter((m) => m.isVisible);

    return visibleModules.map((m) => ({
      ...m,
      installed: installed.includes(m.slug),
    }));
  }

  /**
   * setVisibility - Global, platform-wide toggle for whether a template
   * appears in every tenant's Templates page. Admin-only at the route
   * layer; this method has no role check of its own.
   */
  static async setVisibility(slug: string, isVisible: boolean): Promise<void> {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`Invalid module slug: ${slug}`);
    }
    const [updated] = await db
      .update(modules)
      .set({ isVisible })
      .where(eq(modules.slug, slug))
      .returning({ id: modules.id });

    if (!updated) {
      throw new Error(`Module not found: ${slug}`);
    }

    logger.info({ slug, isVisible }, "Module visibility updated");
  }

  /**
   * installModule - Installs a module for a tenant by running seed SQLs and updating config
   */
  static async installModule(
    tenantId: string,
    slug: string,
    options?: { workflowName?: string },
  ): Promise<void> {
    // Validate slug against allowlist before any filesystem access (path traversal guard)
    if (!SLUG_RE.test(slug)) {
      throw new Error(`Invalid module slug: ${slug}`);
    }

    const [moduleRecord] = await db
      .select()
      .from(modules)
      .where(eq(modules.slug, slug))
      .limit(1);

    if (!moduleRecord) {
      throw new Error(`Module not found: ${slug}`);
    }

    // 1. Check if already installed (read tenant config)
    const [tenantCheck] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenantCheck) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    const config = (tenantCheck.config ?? {}) as Record<string, unknown>;
    const rawList = config.installed_modules;
    const installedList: string[] = Array.isArray(rawList)
      ? (rawList as string[])
      : [];

    if (installedList.includes(slug)) {
      return; // Already installed
    }

    // 2. Run seed SQL files using simple query protocol (supports data-modifying
    //    CTEs). Each file is a single CTE chain executed inside its own
    //    tenant-scoped transaction via executeRawInTenantContext.
    //    NOTE: {WORKFLOW_NAME} is intentionally NOT replaced here. Seed SQL uses
    //    the module's canonical name. If a custom name was requested, it is applied
    //    afterward via a parameterized Drizzle update (see step 3) to avoid SQL injection.
    const seedDir = join(getWorkspaceRoot(), "modules", slug, "seed");
    if (existsSync(seedDir)) {
      const files = await fs.readdir(seedDir);
      const sqlFiles = files
        .filter((f) => f.endsWith(".sql"))
        .sort((a, b) => a.localeCompare(b));

      for (const file of sqlFiles) {
        const filePath = join(seedDir, file);
        const sqlContent = await fs.readFile(filePath, "utf8");

        // Replace only UUID tokens — both are validated as uuid columns by
        // ::uuid cast so non-UUID values will error at the DB layer.
        const processedSql = sqlContent
          .replaceAll("'{TENANT_ID}'", `'${tenantId}'::uuid`)
          .replaceAll("'{MODULE_ID}'", `'${moduleRecord.id}'::uuid`)
          .replaceAll("{WORKFLOW_NAME}", moduleRecord.name);

        if (processedSql.trim().length > 0) {
          await executeRawInTenantContext(tenantId, processedSql);
        }
      }
    } else {
      logger.warn(
        { slug, seedDir },
        "No seed directory found for module during install",
      );
    }

    // 2b. If a custom workflow name was requested, find the workflow created
    //     during seeding by (tenantId, canonical name), then rename it via
    //     a parameterized Drizzle update. Never use entityTypeId = moduleRecord.id
    //     — moduleRecord.id is the modules registry PK, not entity_types.id.
    //     Runs regardless of whether a seed directory existed — a module's
    //     workflow could already exist from an earlier install attempt.
    if (options?.workflowName) {
      const seededWorkflow = await withTenantContext(tenantId, async (tx) => {
        // Primary: exact canonical-name match — works when seed SQL used
        // {WORKFLOW_NAME} (the standard convention going forward, issue #170).
        const [byName] = await tx
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.tenantId, tenantId),
              eq(workflows.name, moduleRecord.name),
            ),
          )
          .limit(1);
        if (byName) return byName;

        // Fallback: resolve via the entity type this module seeded.
        // entity_types.module_id is set from {MODULE_ID} by every module's
        // seed SQL, unlike workflow names, which some modules hardcode
        // instead of using {WORKFLOW_NAME} — issue #170.
        const candidates = await tx
          .select({ id: workflows.id })
          .from(workflows)
          .innerJoin(entityTypes, eq(workflows.entityTypeId, entityTypes.id))
          .where(
            and(
              eq(workflows.tenantId, tenantId),
              eq(entityTypes.moduleId, moduleRecord.id),
            ),
          );

        if (candidates.length > 1) {
          // Ambiguous — module seeded multiple workflows for the same
          // tenant (this was previously reachable for helpdesk, which had
          // a vestigial second seed pipeline alongside its primary one until
          // issue #171 removed it). Refuse to guess which one the caller
          // meant; log instead of silently renaming the wrong one.
          logger.warn(
            {
              tenantId,
              slug,
              moduleId: moduleRecord.id,
              count: candidates.length,
            },
            "installModule: workflowName rename skipped — module seeded multiple workflows, resolution ambiguous",
          );
          return undefined;
        }
        return candidates[0];
      });

      if (seededWorkflow) {
        const newName = options.workflowName;
        await withTenantContext(tenantId, (tx) =>
          tx
            .update(workflows)
            .set({ name: newName })
            .where(eq(workflows.id, seededWorkflow.id)),
        );
      } else {
        logger.warn(
          { tenantId, slug },
          "installModule: workflowName rename requested but no seeded workflow found",
        );
      }
    }

    // 3. Update installed modules list inside a Drizzle transaction
    await withTenantContext(tenantId, async (tx) => {
      installedList.push(slug);
      await tx
        .update(tenants)
        .set({
          config: {
            ...config,
            installed_modules: installedList,
          },
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));
    });
  }

  /**
   * uninstallModule - Uninstalls a module by removing from installed list
   */
  static async uninstallModule(tenantId: string, slug: string): Promise<void> {
    const [moduleRecord] = await db
      .select()
      .from(modules)
      .where(eq(modules.slug, slug))
      .limit(1);

    if (!moduleRecord) {
      throw new Error(`Module not found: ${slug}`);
    }

    await withTenantContext(tenantId, async (tx) => {
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) {
        throw new Error(`Tenant not found: ${tenantId}`);
      }

      const config = (tenant.config ?? {}) as Record<string, unknown>;
      const rawList = config.installed_modules;
      const installedList: string[] = Array.isArray(rawList)
        ? (rawList as string[])
        : [];

      if (!installedList.includes(slug)) {
        return; // Already uninstalled
      }

      const newInstalledList = installedList.filter((m) => m !== slug);

      await tx
        .update(tenants)
        .set({
          config: {
            ...config,
            installed_modules: newInstalledList,
          },
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));
    });
  }
}
