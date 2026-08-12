/**
 * Isolation tests for connector_definitions (migration 0056, issue #363).
 *
 * connector_definitions is a platform-wide connector catalog table — no
 * tenant_id, no RLS (ADR-001's "Non-tenant-scoped tables" section names it
 * explicitly, alongside tenants/modules/entity_types/workflow_templates).
 * There is no cross-tenant boundary to prove here (same shape as
 * platform-settings.isolation.test.ts); the boundary that matters is the
 * write restriction — readable by app_user, writable only by migration_user
 * (no INSERT/UPDATE/DELETE grant in 0056_connector_definitions.sql).
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db, withTenantContext, connectorDefinitions } from "@platform/db";

const TENANT_A = "aaaaaaaa-0056-4000-a000-000000000056";

const seededSlug = `isolation_test_connector_${Date.now()}`;
let seededId: string | undefined;

afterAll(async () => {
  if (seededId) {
    await db
      .delete(connectorDefinitions)
      .where(eq(connectorDefinitions.id, seededId));
  }
});

describe("connector_definitions — catalog read access", () => {
  it("app_user can read rows regardless of app.tenant_id (not tenant-scoped)", async () => {
    // Seed with the plain (superuser) client — app_user has no write grant,
    // matching modules/platform_settings' migration_user-only write model.
    const [row] = await db
      .insert(connectorDefinitions)
      .values({
        slug: seededSlug,
        name: "Isolation Test Connector",
        version: "1.0.0",
        category: "other",
        allowedHosts: ["example.com"],
      })
      .returning();
    if (!row)
      throw new Error("setup: failed to seed connector_definitions row");
    seededId = row.id;

    // Read as app_user with an arbitrary tenant GUC set — the row must still
    // be visible, proving there's no RLS/tenant filter on this table.
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ slug: connectorDefinitions.slug })
        .from(connectorDefinitions)
        .where(eq(connectorDefinitions.id, seededId!)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(seededSlug);
  });

  it("app_user can read rows with no app.tenant_id set at all", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      const rows = await tx
        .select({ slug: connectorDefinitions.slug })
        .from(connectorDefinitions)
        .where(eq(connectorDefinitions.id, seededId!));
      expect(rows).toHaveLength(1);
    });
  });
});

describe("connector_definitions — write restriction (migration_user-only)", () => {
  it("app_user INSERT fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(connectorDefinitions).values({
          slug: `${seededSlug}_insert_attempt`,
          name: "Should Not Insert",
          version: "1.0.0",
          category: "other",
          allowedHosts: ["example.com"],
        });
      }),
      // Postgres permission-denied error code, nested under Drizzle's
      // wrapping DrizzleQueryError.cause (same pattern as the CHECK-
      // constraint pin in api-key-auth.isolation.test.ts).
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user UPDATE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .update(connectorDefinitions)
          .set({ name: "Hijacked" })
          .where(eq(connectorDefinitions.id, seededId!));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user DELETE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .delete(connectorDefinitions)
          .where(eq(connectorDefinitions.id, seededId!));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
