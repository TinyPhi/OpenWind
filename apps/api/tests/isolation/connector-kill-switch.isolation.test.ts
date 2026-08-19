/**
 * Isolation tests for PATCH /connectors/:connectorId/disabled (issue #367).
 *
 * Uses a real Postgres database (no mocks) and the real Hono handler —
 * mirrors api-key-rotate.isolation.test.ts's pattern. Proves, against real
 * RLS + the route's own explicit tenantId filter:
 *  - a tenant can disable/re-enable its own installation
 *  - a tenant cannot disable another tenant's installation of the SAME
 *    connector (404, not a global toggle — each installation is independent)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  withTenantContext,
  connectorDefinitions,
  connectorCredentials,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { setConnectorDisabledHandler } from "../../src/routes/connectors/set-disabled.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000367";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000367";

let connectorId: string;

function appAs(tenantId: string, userId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: ["admin"],
        email: "test@example.com",
      } as AuthContext);
      await next();
    },
  );
  app.patch("/:connectorId/disabled", ...setConnectorDisabledHandler);
  return app;
}

beforeAll(async () => {
  const [conn] = await db
    .insert(connectorDefinitions)
    .values({
      slug: `isolation_test_kill_switch_route_${Date.now()}`,
      name: "Isolation Test Connector (kill switch route)",
      version: "1.0.0",
      category: "other",
      allowedHosts: ["example.com"],
    })
    .returning();
  if (!conn) throw new Error("setup: failed to seed connector row");
  connectorId = conn.id;

  await withTenantContext(TENANT_A, (tx) =>
    tx.insert(connectorCredentials).values({
      tenantId: TENANT_A,
      connectorId,
      secrets: {},
    }),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.insert(connectorCredentials).values({
      tenantId: TENANT_B,
      connectorId,
      secrets: {},
    }),
  );
});

afterAll(async () => {
  await db
    .delete(connectorCredentials)
    .where(eq(connectorCredentials.connectorId, connectorId));
  await db
    .delete(connectorDefinitions)
    .where(eq(connectorDefinitions.id, connectorId));
});

async function readDisabledAt(
  tenantId: string,
  forConnectorId = connectorId,
): Promise<Date | null> {
  const [row] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ disabledAt: connectorCredentials.disabledAt })
      .from(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.tenantId, tenantId),
          eq(connectorCredentials.connectorId, forConnectorId),
        ),
      ),
  );
  return row?.disabledAt ?? null;
}

describe("PATCH /connectors/:connectorId/disabled — real handler + real Postgres", () => {
  it("a tenant can disable and re-enable its own installation", async () => {
    const res = await appAs(TENANT_A, "user-a").request(
      `/${connectorId}/disabled`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      },
    );
    expect(res.status).toBe(200);
    expect(await readDisabledAt(TENANT_A)).toBeInstanceOf(Date);

    const reenable = await appAs(TENANT_A, "user-a").request(
      `/${connectorId}/disabled`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      },
    );
    expect(reenable.status).toBe(200);
    expect(await readDisabledAt(TENANT_A)).toBeNull();
  });

  it("disabling as tenant A never affects tenant B's installation of the same connector", async () => {
    await appAs(TENANT_A, "user-a").request(`/${connectorId}/disabled`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });

    expect(await readDisabledAt(TENANT_A)).toBeInstanceOf(Date);
    expect(await readDisabledAt(TENANT_B)).toBeNull();

    // cleanup for subsequent tests
    await appAs(TENANT_A, "user-a").request(`/${connectorId}/disabled`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: false }),
    });
  });

  it("a tenant with no installation of this connector gets 404, not another tenant's row", async () => {
    const [connOnlyForA] = await db
      .insert(connectorDefinitions)
      .values({
        slug: `isolation_test_kill_switch_a_only_${Date.now()}`,
        name: "Isolation Test Connector (A-only)",
        version: "1.0.0",
        category: "other",
        allowedHosts: ["example.com"],
      })
      .returning();
    if (!connOnlyForA) throw new Error("setup: failed to seed connector row");

    await withTenantContext(TENANT_A, (tx) =>
      tx.insert(connectorCredentials).values({
        tenantId: TENANT_A,
        connectorId: connOnlyForA.id,
        secrets: {},
      }),
    );

    // Tenant B has no installation of connOnlyForA — must 404, not silently
    // affect tenant A's row for the same connectorId.
    const res = await appAs(TENANT_B, "user-b").request(
      `/${connOnlyForA.id}/disabled`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      },
    );
    expect(res.status).toBe(404);
    expect(await readDisabledAt(TENANT_A, connOnlyForA.id)).toBeNull(); // tenant A's row untouched

    await db
      .delete(connectorCredentials)
      .where(eq(connectorCredentials.connectorId, connOnlyForA.id));
    await db
      .delete(connectorDefinitions)
      .where(eq(connectorDefinitions.id, connOnlyForA.id));
  });
});
