/**
 * Regression test for docs/specs/plugin-system.md R13: deleting a tenant must
 * purge that tenant's rows from every installed plugin's schema — a different
 * event from that tenant uninstalling one plugin (R9), and NOT the same as
 * dropping the plugin's schema (which is shared by every tenant that has it
 * installed).
 *
 * Uses a real Postgres database (no mocks on @platform/db) — only BullMQ is
 * mocked, so the processor can be invoked directly against a synthetic job,
 * matching tenant-purge.isolation.test.ts's convention.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  pluginDefinitions,
  installedPlugins,
  runPluginMigration,
} from "@platform/db";

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const TENANT_A = "ffffffff-0059-4000-a000-000000000059"; // gets purged
const TENANT_B = "eeeeeeee-0059-4000-b000-000000000059"; // must survive
const PLUGIN_SLUG = `purge_test_${Date.now()}`.slice(0, 40);
let pluginId: string;

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: TENANT_A,
        name: "R13 purge-target tenant",
        slug: `r13-purge-target-${Date.now()}`,
        status: "deleted",
      },
      {
        id: TENANT_B,
        name: "R13 purge-survivor tenant",
        slug: `r13-purge-survivor-${Date.now()}`,
      },
    ])
    .onConflictDoNothing();

  const [plugin] = await db
    .insert(pluginDefinitions)
    .values({
      slug: PLUGIN_SLUG,
      name: "R13 Purge Test Plugin",
      version: "0.1.0",
      category: "other",
    })
    .returning();
  if (!plugin) throw new Error("setup: failed to seed plugin_definitions row");
  pluginId = plugin.id;

  await runPluginMigration(
    PLUGIN_SLUG,
    `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL);`,
  );

  // Insert one row per tenant directly into the dynamic plugin table — there's
  // no static Drizzle schema for it (it's plugin-authored at runtime), so this
  // uses a raw, role-switched insert exactly the way the lifecycle service's
  // own migration runner does internally.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(
      sql`SET LOCAL ROLE ${sql.raw(`plugin_role_${PLUGIN_SLUG}`)}`,
    );
    await tx.execute(
      sql`INSERT INTO ${sql.raw(`plugin_${PLUGIN_SLUG}`)}.widgets (tenant_id) VALUES (${TENANT_A})`,
    );
    await tx.execute(
      sql`INSERT INTO ${sql.raw(`plugin_${PLUGIN_SLUG}`)}.widgets (tenant_id) VALUES (${TENANT_B})`,
    );
  });

  await db.insert(installedPlugins).values([
    {
      tenantId: TENANT_A,
      pluginId,
      manifestSnapshot: {},
      version: "0.1.0",
      status: "active",
    },
    {
      tenantId: TENANT_B,
      pluginId,
      manifestSnapshot: {},
      version: "0.1.0",
      status: "active",
    },
  ]);

  // Import after mocks + fixtures so the captured processor is ready to run.
  await import("../../src/tenant-purge.js");
});

afterAll(async () => {
  await db
    .delete(installedPlugins)
    .where(eq(installedPlugins.pluginId, pluginId));
  await db.delete(pluginDefinitions).where(eq(pluginDefinitions.id, pluginId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  await db.execute(
    sql`DROP SCHEMA IF EXISTS ${sql.raw(`plugin_${PLUGIN_SLUG}`)} CASCADE`,
  );
  await db.execute(
    sql`DROP ROLE IF EXISTS ${sql.raw(`plugin_role_${PLUGIN_SLUG}`)}`,
  );
});

describe("tenant-purge: plugin schema data (R13)", () => {
  it("deletes only the purged tenant's rows from the plugin's schema, leaving the schema and other tenants' rows intact", async () => {
    expect(capturedProcessor).not.toBeNull();

    await capturedProcessor!({
      id: "r13-purge-test-job",
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { tenantId: TENANT_A },
    });

    const [remainingA] = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text FROM ${sql.raw(`plugin_${PLUGIN_SLUG}`)}.widgets WHERE tenant_id = ${TENANT_A}`,
    );
    expect(remainingA?.count).toBe("0");

    const [remainingB] = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text FROM ${sql.raw(`plugin_${PLUGIN_SLUG}`)}.widgets WHERE tenant_id = ${TENANT_B}`,
    );
    expect(remainingB?.count).toBe("1");

    const [schemaStillExists] = await db.execute<{ schema_name: string }>(
      sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${`plugin_${PLUGIN_SLUG}`}`,
    );
    expect(schemaStillExists).toBeDefined();

    const remainingInstalledPlugins = await db
      .select()
      .from(installedPlugins)
      .where(eq(installedPlugins.tenantId, TENANT_A));
    expect(remainingInstalledPlugins).toHaveLength(0);

    const survivingInstalledPlugins = await db
      .select()
      .from(installedPlugins)
      .where(eq(installedPlugins.tenantId, TENANT_B));
    expect(survivingInstalledPlugins).toHaveLength(1);
  });
});
