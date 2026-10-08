/**
 * T9 (docs/specs/multi-org-sandbox.md Phase 2). Confirms, against a real Postgres
 * instance, that running the actual sandbox module-install + data-seed pipeline
 * (apps/worker/src/sandbox-module-install.ts, sandbox-module-data-seed.ts) produces
 * real entity_instances rows that behave like any other tenant-scoped data under RLS --
 * is_sandbox gets no special-case exemption, same invariant already proven for the
 * tenant row itself (apps/api/tests/isolation/sandbox-provisioning.isolation.test.ts).
 *
 * Uses a real Postgres database (no mocks).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  modules,
  entityTypes,
  entityFields,
  entityInstances,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
  automationRules,
  withTenantContext,
} from "@platform/db";
import { installCoreModulesForSandbox } from "../../src/sandbox-module-install.js";
import { seedAllModulesData } from "../../src/sandbox-module-data-seed.js";

const SANDBOX_TENANT = "dddddddd-0099-4000-d000-000000000099";
const OTHER_TENANT = "cccccccc-0099-4000-c000-000000000099";

let installedSlugs: string[] = [];

// The `modules` registry is normally seeded by apps/api's ModuleService.seedRegistry()
// (called at API startup / in that package's own tests) -- apps/worker cannot import
// apps/api, and no migration seeds these rows (confirmed: no INSERT INTO modules exists
// anywhere in packages/db/migrations), so a CI run that only exercises apps/worker's own
// test suite hits an empty `modules` table unless this test seeds it itself. Matches
// ModuleService.seedRegistry()'s 7 core-module slugs; onConflictDoNothing so this is a
// no-op against a shared dev DB where the real registry already has richer rows.
const CORE_MODULE_SLUGS = [
  "helpdesk",
  "crm",
  "hrms",
  "reimbursements",
  "projects",
  "invoicing",
  "procurement",
];

beforeAll(async () => {
  await db
    .insert(modules)
    .values(
      CORE_MODULE_SLUGS.map((slug) => ({
        slug,
        name: slug,
        version: "0.0.1",
        category: "core" as const,
      })),
    )
    .onConflictDoNothing();

  await db.insert(tenants).values([
    {
      id: SANDBOX_TENANT,
      name: "Isolation Module-Data-Seed Tenant",
      slug: `isolation-module-data-seed-${Date.now()}`,
      isSandbox: true,
    },
    {
      id: OTHER_TENANT,
      name: "Isolation Module-Data-Seed Other Tenant",
      slug: `isolation-module-data-seed-other-${Date.now()}`,
    },
  ]);

  const result = await installCoreModulesForSandbox(SANDBOX_TENANT);
  installedSlugs = result.succeeded;
  await seedAllModulesData(SANDBOX_TENANT, installedSlugs);
}, 60_000);

afterAll(async () => {
  // FK-safe order: workflow_events -> entity_instances/workflow_transitions/
  // workflow_states -> workflows/entity_fields -> entity_types -> tenants.
  await db
    .delete(workflowEvents)
    .where(eq(workflowEvents.tenantId, SANDBOX_TENANT));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, SANDBOX_TENANT));
  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.tenantId, SANDBOX_TENANT));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.tenantId, SANDBOX_TENANT));
  await db.delete(workflows).where(eq(workflows.tenantId, SANDBOX_TENANT));
  await db
    .delete(entityFields)
    .where(eq(entityFields.tenantId, SANDBOX_TENANT));
  await db
    .delete(automationRules)
    .where(eq(automationRules.tenantId, SANDBOX_TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, SANDBOX_TENANT));
  await db.delete(tenants).where(eq(tenants.id, SANDBOX_TENANT));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
});

describe("sandbox module data seeding", () => {
  it("installs at least one core module and seeds real entity_instances rows for it", async () => {
    expect(installedSlugs.length).toBeGreaterThan(0);

    const rows = await withTenantContext(SANDBOX_TENANT, (tx) =>
      tx
        .select({ id: entityInstances.id })
        .from(entityInstances)
        .where(eq(entityInstances.tenantId, SANDBOX_TENANT)),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("seeded records are invisible under a different tenant's context -- is_sandbox gets no RLS exemption", async () => {
    const rows = await withTenantContext(OTHER_TENANT, (tx) =>
      tx
        .select({ id: entityInstances.id })
        .from(entityInstances)
        .where(eq(entityInstances.tenantId, SANDBOX_TENANT)),
    );
    expect(rows).toHaveLength(0);
  });

  it("at least one seeded record has a non-initial currentState, proving real transitions ran", async () => {
    const rows = await withTenantContext(SANDBOX_TENANT, (tx) =>
      tx
        .select({ currentState: entityInstances.currentState })
        .from(entityInstances)
        .where(eq(entityInstances.tenantId, SANDBOX_TENANT)),
    );
    const states = new Set(rows.map((r) => r.currentState));
    expect(states.size).toBeGreaterThan(1);
  });
});
