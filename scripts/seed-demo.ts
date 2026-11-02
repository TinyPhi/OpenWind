#!/usr/bin/env tsx
/**
 * seed-demo.ts
 *
 * Syncs the modules registry (as migration_user) so all templates appear on the Templates page.
 * Does NOT create any tenant-owned entity types, workflows, or records.
 * Users start with a clean slate and fork templates themselves.
 *
 * Run after `pnpm db:seed`:
 *   pnpm seed:demo
 *
 * Safe to re-run — the sync is an idempotent upsert keyed on slug.
 */

import "dotenv/config";
import { syncModuleCatalogAsUrl } from "@platform/db";

async function seed(): Promise<void> {
  console.log("🌱  Syncing module template registry...\n");

  // ADR-005 Amendment 1: the catalog lives in packages/db (module-catalog.ts) and is
  // written by the migration role, never by app_user.
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "MIGRATION_DATABASE_URL is not set — the module catalog is written as migration_user (see docs/local-setup.md)",
    );
  }
  const count = await syncModuleCatalogAsUrl(url);

  console.log("\n✅  Template registry synced!\n");
  console.log(`  ${count} templates available on the Templates page.`);
  console.log(
    "  Users start with a clean slate — fork any template to begin.\n",
  );
  console.log("  Open admin-ui → http://localhost:3001\n");

  process.exit(0);
}

seed().catch((err: unknown) => {
  console.error("Template registry seed failed:", err);
  process.exit(1);
});
