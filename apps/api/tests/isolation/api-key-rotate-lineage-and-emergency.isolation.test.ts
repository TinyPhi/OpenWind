/**
 * Isolation tests for PR A3 (ADR-012 Phase A) against a real Postgres:
 * - rotation lineage cap (spec R4) — rotating a key that itself has a live
 *   predecessor instantly kills that predecessor
 * - rotation's Client-ID handoff (migration 0069/0072) — rotating a third-party
 *   key succeeds without hitting the oidc_client_id partial unique index,
 *   because the predecessor's oidc_client_id_active flag is cleared
 * - Emergency Rotate (spec R5) — instant kill, and killing a live successor
 *   too when the target was itself mid-grace as a Rotate predecessor
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { hashApiKey } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { rotateApiKeyHandler } from "../../src/routes/api-keys/rotate.js";
import { emergencyRotateApiKeyHandler } from "../../src/routes/api-keys/emergency-rotate.js";
import { deleteApiKeyHandler } from "../../src/routes/api-keys/delete.js";

const TENANT = "aaaaaaaa-0000-4000-a000-000000000440";

const allKeyIds: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Rotate Lineage/Emergency Test",
    slug: `rotate-lineage-emergency-${TENANT}`,
  });
});

afterAll(async () => {
  // Delete in reverse-lineage order so rotated_from FK references never
  // point at an already-deleted row.
  for (const id of [...allKeyIds].reverse()) {
    await withTenantContext(TENANT, (tx) =>
      tx.delete(apiKeys).where(eq(apiKeys.id, id)),
    );
  }
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
});

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      tenantId: TENANT,
      userId: "isolation-test-admin",
      roles: ["admin"],
      email: "admin@example.com",
    });
    await next();
  });
  app.post("/:id/rotate", ...rotateApiKeyHandler);
  app.post("/:id/emergency-rotate", ...emergencyRotateApiKeyHandler);
  app.delete("/:id", ...deleteApiKeyHandler);
  return app;
}

function skHeaders() {
  return { Authorization: "Bearer sk_isolation_test_bypass" };
}

async function insertKey(overrides: Partial<typeof apiKeys.$inferInsert>) {
  const [row] = await withTenantContext(TENANT, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT,
        name: overrides.name ?? "rotate-lineage-test",
        keyHash: hashApiKey(
          `sk_rotate_lineage_test_${Math.random().toString(36).slice(2)}`,
        ),
        scopes: ["agent"],
        ...overrides,
      })
      .returning({ id: apiKeys.id }),
  );
  if (!row) throw new Error("api key insert failed");
  allKeyIds.push(row.id);
  return row.id;
}

describe("POST /api-keys/:id/rotate — lineage cap, real Postgres (ADR-012 Phase A spec R4)", () => {
  it("instantly kills a still-live predecessor when rotating a key that itself has one", async () => {
    const grandparentId = await insertKey({ name: "grandparent" });
    const parentId = await insertKey({
      name: "parent",
      rotatedFrom: grandparentId,
    });
    // Simulate grandparent still being "dying" (mid-grace) — not revoked,
    // not expired — exactly the scenario a natural rotation leaves behind.
    expect(grandparentId).toBeTruthy();

    const res = await makeApp().request(`/${parentId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    allKeyIds.push(json.data.id);

    const [grandparentRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt, revokedBy: apiKeys.revokedBy })
        .from(apiKeys)
        .where(eq(apiKeys.id, grandparentId)),
    );
    expect(grandparentRow?.revokedAt).not.toBeNull();
    expect(grandparentRow?.revokedBy).toBe("system:rotation-lineage-cap");
  });

  // Regression test for a real bug found via manual testing: the
  // lineage-cleanup query excluded original.id but not the just-inserted
  // successor's own id, so it caught and instantly revoked the key it had
  // just created — on every single rotation, not just genuine
  // multi-generation scenarios. Two consecutive rotates against real
  // Postgres both self-revoked their own new key within milliseconds before
  // the fix.
  it("does not self-revoke the newly-created successor on an ordinary rotate with no prior lineage", async () => {
    const originalId = await insertKey({ name: "fresh-rotate-original" });

    const res = await makeApp().request(`/${originalId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    allKeyIds.push(json.data.id);

    const [successorRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt, revokedBy: apiKeys.revokedBy })
        .from(apiKeys)
        .where(eq(apiKeys.id, json.data.id)),
    );
    expect(successorRow?.revokedAt).toBeNull();
    expect(successorRow?.revokedBy).toBeNull();
  });

  it("does not self-revoke either the successor when rotating a key that has a live predecessor", async () => {
    const grandparentId = await insertKey({ name: "grandparent-2" });
    const parentId = await insertKey({
      name: "parent-2",
      rotatedFrom: grandparentId,
    });

    const res = await makeApp().request(`/${parentId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    allKeyIds.push(json.data.id);

    const [successorRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, json.data.id)),
    );
    expect(successorRow?.revokedAt).toBeNull();
  });
});

describe("POST /api-keys/:id/rotate — Client ID handoff, real Postgres (migration 0069/0072)", () => {
  it("rotates a third-party key successfully without hitting the oidc_client_id unique index", async () => {
    const clientId = `rotate-handoff-test-${Math.random().toString(36).slice(2)}`;
    const originalId = await insertKey({
      name: "third-party-original",
      scopes: ["entity:ticket:read"],
      scopesFormat: "action",
      applicationName: "Handoff Test App",
      applicationContactEmail: "ops@handoff-test.example",
      oidcClientId: clientId,
    });

    const res = await makeApp().request(`/${originalId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { id: string; oidcClientId: string };
    };
    allKeyIds.push(json.data.id);
    expect(json.data.oidcClientId).toBe(clientId);

    const [originalRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({
          revokedAt: apiKeys.revokedAt,
          oidcClientIdActive: apiKeys.oidcClientIdActive,
          oidcClientId: apiKeys.oidcClientId,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, originalId)),
    );
    // Still authenticating (not revoked) — the whole point of the grace
    // window — but no longer the uniqueness holder, and its Client ID value
    // is unchanged (still identifies the right application).
    expect(originalRow?.revokedAt).toBeNull();
    expect(originalRow?.oidcClientIdActive).toBe(false);
    expect(originalRow?.oidcClientId).toBe(clientId);
  });
});

describe("POST /api-keys/:id/emergency-rotate — real Postgres (ADR-012 Phase A spec R5)", () => {
  it("kills the target instantly and issues a working replacement", async () => {
    const targetId = await insertKey({ name: "emergency-target" });

    const res = await makeApp().request(`/${targetId}/emergency-rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; key: string } };
    allKeyIds.push(json.data.id);
    expect(json.data.key).toMatch(/^sk_live_/);

    const [targetRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, targetId)),
    );
    expect(targetRow?.revokedAt).not.toBeNull();
  });

  it("also kills a live successor when the target was mid-grace as a Rotate predecessor", async () => {
    const targetId = await insertKey({ name: "emergency-with-successor" });
    const rotateRes = await makeApp().request(`/${targetId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(rotateRes.status).toBe(201);
    const rotateJson = (await rotateRes.json()) as { data: { id: string } };
    const successorId = rotateJson.data.id;
    allKeyIds.push(successorId);

    // targetId is now dying (mid-24h-grace) with a live successor.
    const emergencyRes = await makeApp().request(
      `/${targetId}/emergency-rotate`,
      { method: "POST", headers: skHeaders() },
    );
    expect(emergencyRes.status).toBe(201);
    const emergencyJson = (await emergencyRes.json()) as {
      data: { id: string };
    };
    allKeyIds.push(emergencyJson.data.id);

    const [successorRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, successorId)),
    );
    expect(successorRow?.revokedAt).not.toBeNull();
  });

  // Regression test for a real bug found by review (PrabhuVijit, PR #446):
  // the target/successor revoke used to run AFTER the insert. For a
  // third-party key the new row carries the target's own oidcClientId
  // forward, so with the target still holding oidc_client_id_active=true
  // at insert time, this always hit the api_keys_oidc_client_id_active_unique
  // constraint — a genuine 500, not the intended clean success. The two
  // tests above never caught this because they only used role-format keys
  // (oidcClientId always null), which can never collide on that index.
  it("emergency-rotates a real third-party key without hitting the oidc_client_id unique constraint", async () => {
    const clientId = `emergency-rotate-test-${Math.random().toString(36).slice(2)}`;
    const targetId = await insertKey({
      name: "emergency-third-party-target",
      scopes: ["entity:ticket:read"],
      scopesFormat: "action",
      applicationName: "Emergency Rotate Test App",
      applicationContactEmail: "ops@emergency-rotate-test.example",
      oidcClientId: clientId,
    });

    const res = await makeApp().request(`/${targetId}/emergency-rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { id: string; oidcClientId: string };
    };
    allKeyIds.push(json.data.id);
    expect(json.data.oidcClientId).toBe(clientId);

    const [targetRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, targetId)),
    );
    expect(targetRow?.revokedAt).not.toBeNull();
  });
});

describe("DELETE /api-keys/:id — decommission a key mid-rotation-grace, real Postgres (ADR-012 Phase A spec R9)", () => {
  // Spec R9: "same rejection path as Revoke — no grace, regardless of
  // whether the key was mid-rotation-grace at the time." Revoke and
  // decommission share one handler (delete.ts) with no special-casing for a
  // key's rotation-lineage state, so this is the case that would break first
  // if a future change ever taught delete.ts to look at rotatedFrom/grace
  // status — a still-dying predecessor must die on revoke exactly as
  // instantly as any ordinary active key would.
  it("instantly revokes a dying predecessor instead of letting it finish its 24h grace", async () => {
    const originalId = await insertKey({ name: "decommission-mid-grace" });

    const rotateRes = await makeApp().request(`/${originalId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(rotateRes.status).toBe(201);
    const rotateJson = (await rotateRes.json()) as { data: { id: string } };
    allKeyIds.push(rotateJson.data.id);

    // originalId is now the dying predecessor, mid-24h-grace, revokedAt still
    // null and expiresAt still ~24h out — exactly the state R9 targets.
    const [beforeRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt, expiresAt: apiKeys.expiresAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, originalId)),
    );
    expect(beforeRow?.revokedAt).toBeNull();
    expect(beforeRow?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    const deleteRes = await makeApp().request(`/${originalId}`, {
      method: "DELETE",
      headers: skHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    const [afterRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, originalId)),
    );
    expect(afterRow?.revokedAt).not.toBeNull();
  });
});
