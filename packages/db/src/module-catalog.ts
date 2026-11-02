import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { modules } from "./schema/platform.js";

// ADR-005 Amendment 1: the module catalog is authored here, once, and written
// only by the migration role (run-migrations.ts calls syncModuleCatalog right
// after the migrations). app_user has SELECT on `modules` plus a column-scoped
// UPDATE on is_visible (migration 0159); it can never rewrite what
// `category = 'core'` auto-installs.
//
// category: "core" modules are auto-installed by provisionTenant, "optional"
// modules are manual installs (ADR-005). Reclassification policy is ADR-020.

export const ModuleCatalogEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  isSystem: z.boolean(),
  minPlan: z.string().min(1),
  category: z.enum(["core", "optional"]),
});
export type ModuleCatalogEntry = z.infer<typeof ModuleCatalogEntrySchema>;

const CATALOG_ENTRIES: ModuleCatalogEntry[] = [
  {
    slug: "helpdesk",
    name: "Helpdesk",
    description:
      "Support ticket management with priority, SLA, and category tracking",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "crm",
    name: "CRM",
    description: "Sales pipeline and deal tracking from lead to close",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "hrms",
    name: "HRMS",
    description: "Leave request and employee workflow management",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "reimbursements",
    name: "Reimbursements",
    description: "Expense claim submission, approval, and payment tracking",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "projects",
    name: "Projects",
    description:
      "Task and project tracking with backlog, sprint, and review stages",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "invoicing",
    name: "Invoicing",
    description: "Invoice lifecycle from draft through sent, viewed, to paid",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "procurement",
    name: "Procurement",
    description: "Purchase order requests, approvals, and delivery tracking",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "core",
  },
  {
    slug: "tender",
    name: "Tender Management",
    description:
      "Tender lifecycle from draft through BOQ, isolated costing review, and submission",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "optional",
  },
  {
    slug: "vendor-approval",
    name: "Vendor Approval",
    description:
      "Sequential vendor onboarding approval: IT Security, Legal, then Finance sign-off",
    version: "0.0.1",
    isSystem: false,
    minPlan: "standard",
    category: "optional",
  },
];

export const MODULE_CATALOG: readonly ModuleCatalogEntry[] = z
  .array(ModuleCatalogEntrySchema)
  .parse(CATALOG_ENTRIES);

/** Any drizzle postgres-js executor (a db handle or a transaction). */
export type ModuleCatalogExecutor = Pick<
  PgDatabase<PgQueryResultHKT>,
  "insert"
>;

/**
 * Idempotent upsert of MODULE_CATALOG keyed on slug. Refreshes name,
 * description, version, is_system, min_plan, category and updated_at. Never
 * touches is_visible (an operator setting) or created_at. Needs INSERT and
 * UPDATE on `modules`, so it must run as the migration role (or a superuser).
 * Returns the number of catalog entries synced.
 */
export async function syncModuleCatalog(
  executor: ModuleCatalogExecutor,
): Promise<number> {
  for (const mod of MODULE_CATALOG) {
    await executor
      .insert(modules)
      .values(mod)
      .onConflictDoUpdate({
        target: modules.slug,
        set: {
          name: mod.name,
          description: mod.description,
          version: mod.version,
          isSystem: mod.isSystem,
          minPlan: mod.minPlan,
          category: mod.category,
          updatedAt: sql`now()`,
        },
      });
  }
  return MODULE_CATALOG.length;
}

/**
 * Opens a short-lived connection to `url` (which must be a migration-role or
 * superuser URL), syncs the catalog and closes it. For dev scripts that run
 * outside run-migrations.ts and cannot use the app-role `db`. With
 * `{ reset: true }` it first deletes every row, in the same transaction as the
 * re-sync, so a reader never sees an empty catalog (scripts/reset-data.ts).
 */
export async function syncModuleCatalogAsUrl(
  url: string,
  options: { reset?: boolean } = {},
): Promise<number> {
  const client = postgres(url, { max: 1, prepare: false });
  try {
    return await drizzle(client).transaction(async (tx) => {
      if (options.reset) {
        await tx.delete(modules);
      }
      return syncModuleCatalog(tx);
    });
  } finally {
    await client.end();
  }
}
