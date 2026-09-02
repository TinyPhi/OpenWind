/**
 * Isolation tests for PATCH /api-keys/:id (ADR-012 Phase A, PR A5, AC7) —
 * against a real Postgres. Confirms the update is genuinely tenant-scoped
 * (a key from another tenant, or another tenant's ID entirely, 404s rather
 * than leaking existence or succeeding cross-tenant) and that a revoked key
 * can no longer be edited.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { updateApiKeyHandler } from "../../src/routes/api-keys/update.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000450";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000450";

const keyIds: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT_A, name: "Update Test A", slug: `update-test-a-${TENANT_A}` },
    { id: TENANT_B, name: "Update Test B", slug: `update-test-b-${TENANT_B}` },
  ]);
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(inArray(apiKeys.id, keyIds)),
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
  app.patch("/:id", ...updateApiKeyHandler);
  return app;
}

function skHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_isolation_test_bypass",
  };
}

async function insertKey(overrides: Partial<typeof apiKeys.$inferInsert> = {}) {
  const unique = Math.random().toString(36).slice(2);
  const [row] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "update-test-key",
        keyHash: `sha256:update-test-${unique}`,
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        // Migration 0087/0088 enforces per-tenant applicationName
        // uniqueness among active keys -- unique per call so this file's
        // real subject (tenant-scoped PATCH behavior) isn't accidentally
        // blocked by an unrelated applicationName collision between its
        // own test cases, most of which insert more than one key in the
        // same tenant.
        applicationName: `Update Test App (${unique})`,
        applicationDescription: "Original description",
        applicationContactEmail: "original@example.com",
        ...overrides,
      })
      .returning({ id: apiKeys.id }),
  );
  if (!row) throw new Error("api key insert failed");
  keyIds.push(row.id);
  return row.id;
}

describe("PATCH /api-keys/:id — real Postgres (ADR-012 Phase A PR A5, AC7)", () => {
  it("updates applicationDescription and applicationContactEmail for the caller's own tenant", async () => {
    const id = await insertKey();

    const res = await makeApp(TENANT_A).request(`/${id}`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({
        applicationDescription: "New description",
        applicationContactEmail: "new@example.com",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { applicationDescription: string; applicationContactEmail: string };
    };
    expect(json.data.applicationDescription).toBe("New description");
    expect(json.data.applicationContactEmail).toBe("new@example.com");
  });

  it("returns 404 for a key belonging to a different tenant, not a leaked 403", async () => {
    const id = await insertKey();

    const res = await makeApp(TENANT_B).request(`/${id}`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ applicationDescription: "Hijacked" }),
    });
    expect(res.status).toBe(404);

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ applicationDescription: apiKeys.applicationDescription })
        .from(apiKeys)
        .where(eq(apiKeys.id, id)),
    );
    expect(row?.applicationDescription).toBe("Original description");
  });

  it("returns 404 for a revoked key — a revoked key can no longer be edited", async () => {
    const id = await insertKey();
    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: "isolation-test-admin" })
        .where(eq(apiKeys.id, id)),
    );

    const res = await makeApp(TENANT_A).request(`/${id}`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ applicationDescription: "Should not apply" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when trying to update a role-format (internal) key", async () => {
    const id = await insertKey({
      scopes: ["agent"],
      scopesFormat: "role",
    });

    const res = await makeApp(TENANT_A).request(`/${id}`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ applicationDescription: "Should fail" }),
    });
    expect(res.status).toBe(404);
  });

  it("leaves name, scopes, and oidcClientId completely unchanged — only description/email are ever accepted", async () => {
    const id = await insertKey({
      scopes: ["entity:ticket:read"],
      scopesFormat: "action",
      oidcClientId: `update-test-client-${Math.random().toString(36).slice(2)}`,
    });

    await makeApp(TENANT_A).request(`/${id}`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ applicationDescription: "Edited" }),
    });

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          oidcClientId: apiKeys.oidcClientId,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, id)),
    );
    expect(row?.name).toBe("update-test-key");
    expect(row?.scopes).toEqual(["entity:ticket:read"]);
    expect(row?.oidcClientId).toMatch(/^update-test-client-/);
  });
});
