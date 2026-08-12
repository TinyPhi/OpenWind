/**
 * Isolation tests for connector_credentials (migration 0056, issue #363).
 *
 * connector_credentials is tenant-scoped and RLS-protected (policies
 * `tenant_read`/`tenant_write` from migration 0001 — unchanged by 0056's
 * column reshape). Verifies:
 *  - a tenant can insert/select its own installation row via
 *    withTenantContext (proves the pre-existing app_user grant still works
 *    against the new column shape)
 *  - real cross-tenant RLS: tenant A cannot see tenant B's row
 *  - the new `(tenant_id, connector_id)` UNIQUE constraint (migration 0056)
 *    rejects a second installation of the same connector for the same tenant
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  connectorDefinitions,
  connectorCredentials,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-0056-4000-a000-000000000056";
const TENANT_B = "bbbbbbbb-0056-4000-b000-000000000056";

let connectorId: string;

beforeAll(async () => {
  // Seed the catalog row with the plain (superuser) client — app_user has no
  // write grant on connector_definitions (see connector-definitions.isolation.test.ts).
  const [row] = await db
    .insert(connectorDefinitions)
    .values({
      slug: `isolation_test_connector_creds_${Date.now()}`,
      name: "Isolation Test Connector (credentials)",
      version: "1.0.0",
      category: "other",
      allowedHosts: ["example.com"],
    })
    .returning();
  if (!row) throw new Error("setup: failed to seed connector_definitions row");
  connectorId = row.id;
});

afterAll(async () => {
  await db
    .delete(connectorCredentials)
    .where(eq(connectorCredentials.connectorId, connectorId));
  await db
    .delete(connectorDefinitions)
    .where(eq(connectorDefinitions.id, connectorId));
});

describe("connector_credentials — write + read via app_user grant", () => {
  it("a tenant can insert and read its own installation row", async () => {
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(connectorCredentials)
        .values({
          tenantId: TENANT_A,
          connectorId,
          secrets: { accessToken: "ciphertext-a" },
        })
        .returning(),
    );
    expect(row).toBeDefined();
    expect(row?.secrets).toEqual({ accessToken: "ciphertext-a" });

    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(connectorCredentials)
        .where(eq(connectorCredentials.id, row!.id)),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("connector_credentials — cross-tenant RLS isolation", () => {
  let rowAId: string;
  let rowBId: string;

  beforeAll(async () => {
    // Use two distinct connector rows so tenant A/B installs don't collide
    // with the (tenant_id, connector_id) unique constraint under test below.
    const [connB] = await db
      .insert(connectorDefinitions)
      .values({
        slug: `isolation_test_connector_creds_b_${Date.now()}`,
        name: "Isolation Test Connector B",
        version: "1.0.0",
        category: "other",
        allowedHosts: ["example.com"],
      })
      .returning();
    if (!connB) throw new Error("setup: failed to seed second connector row");

    const [rowA] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(connectorCredentials)
        .values({
          tenantId: TENANT_A,
          connectorId: connB.id,
          secrets: { accessToken: "tenant-a-secret" },
        })
        .returning({ id: connectorCredentials.id }),
    );
    if (!rowA) throw new Error("setup: tenant A insert failed");
    rowAId = rowA.id;

    const [rowB] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .insert(connectorCredentials)
        .values({
          tenantId: TENANT_B,
          connectorId: connB.id,
          secrets: { accessToken: "tenant-b-secret" },
        })
        .returning({ id: connectorCredentials.id }),
    );
    if (!rowB) throw new Error("setup: tenant B insert failed");
    rowBId = rowB.id;
  });

  it("tenant A cannot read tenant B's installation row", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ id: connectorCredentials.id })
        .from(connectorCredentials)
        .where(eq(connectorCredentials.id, rowBId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("tenant B cannot read tenant A's installation row", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ id: connectorCredentials.id })
        .from(connectorCredentials)
        .where(eq(connectorCredentials.id, rowAId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("each tenant can still read its own row", async () => {
    const ownA = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ id: connectorCredentials.id })
        .from(connectorCredentials)
        .where(eq(connectorCredentials.id, rowAId)),
    );
    expect(ownA).toHaveLength(1);

    const ownB = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ id: connectorCredentials.id })
        .from(connectorCredentials)
        .where(eq(connectorCredentials.id, rowBId)),
    );
    expect(ownB).toHaveLength(1);
  });
});

describe("connector_credentials — (tenant_id, connector_id) uniqueness", () => {
  it("a second install of the same connector for the same tenant is rejected", async () => {
    const [conn] = await db
      .insert(connectorDefinitions)
      .values({
        slug: `isolation_test_connector_creds_unique_${Date.now()}`,
        name: "Isolation Test Connector (uniqueness)",
        version: "1.0.0",
        category: "other",
        allowedHosts: ["example.com"],
      })
      .returning();
    if (!conn) throw new Error("setup: failed to seed connector row");

    await withTenantContext(TENANT_A, (tx) =>
      tx.insert(connectorCredentials).values({
        tenantId: TENANT_A,
        connectorId: conn.id,
        secrets: { accessToken: "first-install" },
      }),
    );

    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(connectorCredentials).values({
          tenantId: TENANT_A,
          connectorId: conn.id,
          secrets: { accessToken: "second-install-attempt" },
        }),
      ),
      // Pinned to the unique-violation Postgres code specifically, nested
      // under Drizzle's wrapping DrizzleQueryError.cause (same pattern as
      // the CHECK-constraint pin in api-key-auth.isolation.test.ts).
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // A different tenant installing the same connector is unaffected —
    // uniqueness is scoped per-tenant, not global.
    const [otherTenantRow] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .insert(connectorCredentials)
        .values({
          tenantId: TENANT_B,
          connectorId: conn.id,
          secrets: { accessToken: "tenant-b-same-connector" },
        })
        .returning(),
    );
    expect(otherTenantRow).toBeDefined();

    await db
      .delete(connectorCredentials)
      .where(eq(connectorCredentials.connectorId, conn.id));
    await db
      .delete(connectorDefinitions)
      .where(eq(connectorDefinitions.id, conn.id));
  });
});
