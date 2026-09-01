/**
 * Isolation tests for GET /admin/third-party-access-logs's `application`
 * filter (apps/api/src/routes/admin/third-party-access-logs.ts) — this route
 * previously had no test coverage of any kind (unit or isolation). Added
 * alongside widening the filter to accept multiple application (api key)
 * ids, needed for the Admin-UI API Keys detail view where one "application"
 * can span several key rows (rotations) and its access-log view must show
 * entries from all of them, not just one.
 *
 * Uses a real Postgres database (no mocks) — exercises the real route,
 * queryAuditLog, and RLS/tenant scoping together.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { hashApiKey } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { getThirdPartyAccessLogsHandler } from "../../src/routes/admin/third-party-access-logs.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000487";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000487";

const mintedKeyIdsA: string[] = [];
const mintedKeyIdsB: string[] = [];

let keyA1Id: string;
let keyA2Id: string;
let keyBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Access Logs Multi-App Test A",
      slug: `access-logs-multi-app-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Access Logs Multi-App Test B",
      slug: `access-logs-multi-app-b-${TENANT_B}`,
    },
  ]);

  // Two key rows in Tenant A under the SAME application name (simulating a
  // rotation lineage) plus one unrelated key in Tenant B.
  // Simulates a rotation lineage: migration 0086's unique index only allows
  // ONE active row per (tenant, normalized applicationName) at a time, so
  // the old key must already be revoked before the new one exists — exactly
  // what a real rotation does (rotate.ts revokes the old row when minting
  // the replacement). Both key ids still belong to "the same application"
  // for the access-log filter this test exercises.
  const [rowA1] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "multi-app-test-a1",
        keyHash: hashApiKey("sk_multi_app_test_a1"),
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        applicationName: "Multi App Test",
        oidcClientId: "multi-app-test-client-a1",
      })
      .returning({ id: apiKeys.id }),
  );
  if (!rowA1) throw new Error("api key insert failed");
  await withTenantContext(TENANT_A, (tx) =>
    tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedBy: "isolation-test-rotation" })
      .where(eq(apiKeys.id, rowA1.id)),
  );
  const [rowA2] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "multi-app-test-a2",
        keyHash: hashApiKey("sk_multi_app_test_a2"),
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        applicationName: "Multi App Test",
        oidcClientId: "multi-app-test-client-a2",
      })
      .returning({ id: apiKeys.id }),
  );
  const [rowB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_B,
        name: "multi-app-test-b",
        keyHash: hashApiKey("sk_multi_app_test_b"),
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        applicationName: "Unrelated App",
        oidcClientId: "multi-app-test-client-b",
      })
      .returning({ id: apiKeys.id }),
  );
  if (!rowA1 || !rowA2 || !rowB) {
    throw new Error("api key insert failed");
  }
  keyA1Id = rowA1.id;
  keyA2Id = rowA2.id;
  keyBId = rowB.id;
  mintedKeyIdsA.push(keyA1Id, keyA2Id);
  mintedKeyIdsB.push(keyBId);

  const ticketId = "cccccccc-0000-4000-c000-000000000001";
  await withTenantContext(TENANT_A, (tx) =>
    writeAuditEntry(tx, {
      tenantId: TENANT_A,
      actorId: keyA1Id,
      actorType: "api_key",
      resourceType: "ticket",
      resourceId: ticketId,
      action: "created",
    }),
  );
  await withTenantContext(TENANT_A, (tx) =>
    writeAuditEntry(tx, {
      tenantId: TENANT_A,
      actorId: keyA2Id,
      actorType: "api_key",
      resourceType: "ticket",
      resourceId: ticketId,
      action: "created",
    }),
  );
  await withTenantContext(TENANT_B, (tx) =>
    writeAuditEntry(tx, {
      tenantId: TENANT_B,
      actorId: keyBId,
      actorType: "api_key",
      resourceType: "ticket",
      resourceId: ticketId,
      action: "created",
    }),
  );
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(inArray(apiKeys.id, mintedKeyIdsA)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(apiKeys).where(inArray(apiKeys.id, mintedKeyIdsB)),
  );
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

function makeApp(tenantId: string = TENANT_A) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      tenantId,
      userId: "isolation-test-admin",
      roles: ["admin"],
      email: "admin@example.com",
    });
    await next();
  });
  app.get("/", ...getThirdPartyAccessLogsHandler);
  return app;
}

describe("GET /admin/third-party-access-logs — application filter, real Postgres", () => {
  it("filters by a single application (key) id, unchanged from before", async () => {
    const res = await makeApp().request(`/?application=${keyA1Id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ applicationKeyId: string }>;
    };
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data.every((row) => row.applicationKeyId === keyA1Id)).toBe(
      true,
    );
  });

  it("filters by a comma-separated list of application ids, matching entries from any of them", async () => {
    const res = await makeApp().request(`/?application=${keyA1Id},${keyA2Id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ applicationKeyId: string }>;
    };
    const seenKeyIds = new Set(json.data.map((row) => row.applicationKeyId));
    expect(seenKeyIds.has(keyA1Id)).toBe(true);
    expect(seenKeyIds.has(keyA2Id)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(2);
  });

  it("never returns another tenant's entries even when its key id is included in the filter list", async () => {
    const res = await makeApp(TENANT_A).request(
      `/?application=${keyA1Id},${keyBId}`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ applicationKeyId: string }>;
    };
    expect(json.data.every((row) => row.applicationKeyId !== keyBId)).toBe(
      true,
    );
  });

  it("rejects a malformed id in the list with 400, not a silent partial match", async () => {
    const res = await makeApp().request(`/?application=${keyA1Id},not-a-uuid`);
    expect(res.status).toBe(400);
  });
});
