import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  entityFields,
  workflows,
  workflowStates,
  workflowTransitions,
  modules,
} from "@platform/db";
import { ModuleService } from "../../src/services/module-service.js";

// ── ModuleService.installCoreModules (#163, #165 — ADR-005) ─────────────────
//
// installCoreModules installs every `category = 'core'` module for a tenant,
// attempting each independently so one module's failure never blocks the
// rest — they are unrelated business domains, and #161 made every standard
// module's seed SQL idempotent, so a failed module can always be retried
// later via POST /modules/:slug/install without risking duplicate rows.

describe("ModuleService.installCoreModules", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000165";

  beforeAll(async () => {
    await db
      .insert(tenants)
      .values({
        id: TENANT_ID,
        name: "Test Core Install Tenant",
        slug: "test-core-install-tenant",
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();
    await ModuleService.seedRegistry();
  });

  afterAll(async () => {
    const wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, TENANT_ID));
    for (const wf of wfs) {
      await db
        .delete(workflowTransitions)
        .where(eq(workflowTransitions.workflowId, wf.id));
      await db
        .delete(workflowStates)
        .where(eq(workflowStates.workflowId, wf.id));
    }
    await db.delete(workflows).where(eq(workflows.tenantId, TENANT_ID));
    await db.delete(entityFields).where(eq(entityFields.tenantId, TENANT_ID));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_ID));
    await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
  });

  it("installs every module classified as 'core' per ADR-005 and reports them all as succeeded", async () => {
    const result = await ModuleService.installCoreModules(TENANT_ID);

    expect(result.failed).toEqual([]);
    expect(result.succeeded.sort()).toEqual(
      [
        "crm",
        "helpdesk",
        "hrms",
        "invoicing",
        "procurement",
        "projects",
        "reimbursements",
      ].sort(),
    );
    // tender is 'optional' per ADR-005 — must never auto-install
    expect(result.succeeded).not.toContain("tender");

    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .limit(1);
    const installed = (tenant?.config as Record<string, unknown>)[
      "installed_modules"
    ] as string[];
    expect(installed).not.toContain("tender");
    expect(installed).toContain("helpdesk");
  });

  it("continues installing remaining core modules when one module's slug is invalid, and reports it as failed", async () => {
    const tenantId = "00000000-0000-0000-0000-000000000166";
    await db
      .insert(tenants)
      .values({
        id: tenantId,
        name: "Test Core Install Failure Tenant",
        slug: "test-core-install-failure-tenant",
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();

    // A slug that fails installModule's SLUG_RE check (path-traversal guard)
    // reliably throws — inserted directly via the DB layer since installModule's
    // own validation only runs inside installModule itself, not at the schema
    // level, so this bypasses it exactly the way a bad row would in practice.
    const BOGUS_SLUG = "test_165_bogus_core";
    const [bogus] = await db
      .insert(modules)
      .values({
        slug: BOGUS_SLUG,
        name: "Bogus Core Module",
        version: "0.0.1",
        category: "core",
      })
      .onConflictDoUpdate({
        target: modules.slug,
        set: { category: "core" },
      })
      .returning({ id: modules.id });

    try {
      const result = await ModuleService.installCoreModules(tenantId);

      expect(result.succeeded).toContain("helpdesk");
      expect(result.failed).toEqual(
        expect.arrayContaining([expect.objectContaining({ slug: BOGUS_SLUG })]),
      );
    } finally {
      if (bogus) await db.delete(modules).where(eq(modules.id, bogus.id));
      const wfs = await db
        .select()
        .from(workflows)
        .where(eq(workflows.tenantId, tenantId));
      for (const wf of wfs) {
        await db
          .delete(workflowTransitions)
          .where(eq(workflowTransitions.workflowId, wf.id));
        await db
          .delete(workflowStates)
          .where(eq(workflowStates.workflowId, wf.id));
      }
      await db.delete(workflows).where(eq(workflows.tenantId, tenantId));
      await db.delete(entityFields).where(eq(entityFields.tenantId, tenantId));
      await db.delete(entityTypes).where(eq(entityTypes.tenantId, tenantId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });
});
