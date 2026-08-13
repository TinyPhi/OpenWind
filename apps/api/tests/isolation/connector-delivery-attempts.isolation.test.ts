/**
 * Isolation tests for connector_delivery_attempts (migration 0057, issue #365,
 * ADR-009 Decision #9).
 *
 * Tenant-scoped, RLS-protected (USING + WITH CHECK, matching current
 * best-practice per 0048/0049 — see migration 0057's header comment for why
 * this ships with both from day one rather than the older USING-only
 * pattern). tenant_id has a real FK to tenants(id) (unlike
 * connector_credentials, which has none), so real tenant rows are seeded
 * here rather than using arbitrary UUIDs.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  connectorDefinitions,
  connectorDeliveryAttempts,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-0057-4000-a000-000000000057";
const TENANT_B = "bbbbbbbb-0057-4000-b000-000000000057";

let connectorId: string;

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: TENANT_A,
        name: "Issue #365 isolation tenant A",
        slug: `issue-365-tenant-a-${Date.now()}`,
      },
      {
        id: TENANT_B,
        name: "Issue #365 isolation tenant B",
        slug: `issue-365-tenant-b-${Date.now()}`,
      },
    ])
    .onConflictDoNothing();

  const [conn] = await db
    .insert(connectorDefinitions)
    .values({
      slug: `isolation_test_connector_delivery_${Date.now()}`,
      name: "Isolation Test Connector (delivery attempts)",
      version: "1.0.0",
      category: "other",
      allowedHosts: ["example.com"],
    })
    .returning();
  if (!conn) throw new Error("setup: failed to seed connector_definitions row");
  connectorId = conn.id;
});

afterAll(async () => {
  await db
    .delete(connectorDeliveryAttempts)
    .where(eq(connectorDeliveryAttempts.tenantId, TENANT_A));
  await db
    .delete(connectorDeliveryAttempts)
    .where(eq(connectorDeliveryAttempts.tenantId, TENANT_B));
  await db
    .delete(connectorDefinitions)
    .where(eq(connectorDefinitions.id, connectorId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("connector_delivery_attempts — RLS isolation", () => {
  let rowAId: string;
  let rowBId: string;

  it("a tenant can insert and read its own attempt row", async () => {
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(connectorDeliveryAttempts)
        .values({
          tenantId: TENANT_A,
          connectorId,
          deliveryId: "11111111-1111-4111-a111-111111111111",
          status: "pending",
          attemptNumber: 1,
        })
        .returning(),
    );
    expect(row).toBeDefined();
    rowAId = row!.id;

    const own = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.id, rowAId)),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.status).toBe("pending");
  });

  it("tenant B cannot read tenant A's attempt row", async () => {
    const [rowB] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .insert(connectorDeliveryAttempts)
        .values({
          tenantId: TENANT_B,
          connectorId,
          deliveryId: "22222222-2222-4222-a222-222222222222",
          status: "pending",
          attemptNumber: 1,
        })
        .returning(),
    );
    expect(rowB).toBeDefined();
    rowBId = rowB!.id;

    const cross = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.id, rowBId)),
    );
    expect(cross).toHaveLength(0);
  });

  it("a tenant cannot insert an attempt row under another tenant's tenant_id (WITH CHECK)", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(connectorDeliveryAttempts).values({
          tenantId: TENANT_B,
          connectorId,
          deliveryId: "33333333-3333-4333-a333-333333333333",
          status: "pending",
          attemptNumber: 1,
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot update another tenant's attempt row", async () => {
    const res = await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(connectorDeliveryAttempts)
        .set({ status: "success" })
        .where(eq(connectorDeliveryAttempts.id, rowBId))
        .returning(),
    );
    expect(res).toHaveLength(0);
  });

  it("app_user can update its own tenant's attempt row (pending -> success)", async () => {
    const [updated] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(connectorDeliveryAttempts)
        .set({ status: "success", latencyMs: 123 })
        .where(eq(connectorDeliveryAttempts.id, rowAId))
        .returning(),
    );
    expect(updated?.status).toBe("success");
    expect(updated?.latencyMs).toBe(123);
  });

  it("app_user can delete its own tenant's attempt rows (tenant-purge dependency)", async () => {
    await withTenantContext(TENANT_B, (tx) =>
      tx
        .delete(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.id, rowBId)),
    );
    const remaining = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select()
        .from(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.id, rowBId)),
    );
    expect(remaining).toHaveLength(0);
  });
});

describe("connector_delivery_attempts — CHECK constraint on status", () => {
  it("rejects a status value outside pending|success|failed|exhausted", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(connectorDeliveryAttempts).values({
          tenantId: TENANT_A,
          connectorId,
          deliveryId: "44444444-4444-4444-a444-444444444444",
          // @ts-expect-error - deliberately invalid to exercise the DB CHECK constraint
          status: "bogus",
          attemptNumber: 1,
        }),
      ),
      // Pinned to the CHECK-constraint violation code specifically, nested
      // under Drizzle's wrapping DrizzleQueryError.cause (same pattern as
      // api-key-auth.isolation.test.ts).
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

describe("connector_delivery_attempts — connector_id ON DELETE SET NULL", () => {
  it("survives the referenced connector_definitions row being deleted", async () => {
    const [conn] = await db
      .insert(connectorDefinitions)
      .values({
        slug: `isolation_test_connector_delivery_ondelete_${Date.now()}`,
        name: "Isolation Test Connector (ON DELETE SET NULL)",
        version: "1.0.0",
        category: "other",
        allowedHosts: ["example.com"],
      })
      .returning();
    if (!conn) throw new Error("setup: failed to seed connector row");

    const [attempt] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(connectorDeliveryAttempts)
        .values({
          tenantId: TENANT_A,
          connectorId: conn.id,
          deliveryId: "55555555-5555-4555-a555-555555555555",
          status: "exhausted",
          attemptNumber: 5,
          error: "target unreachable",
        })
        .returning(),
    );
    if (!attempt) throw new Error("setup: attempt insert failed");

    await db
      .delete(connectorDefinitions)
      .where(eq(connectorDefinitions.id, conn.id));

    const [afterDelete] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ connectorId: connectorDeliveryAttempts.connectorId })
        .from(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.id, attempt.id)),
    );
    expect(afterDelete?.connectorId).toBeNull();

    await db
      .delete(connectorDeliveryAttempts)
      .where(eq(connectorDeliveryAttempts.id, attempt.id));
  });
});
