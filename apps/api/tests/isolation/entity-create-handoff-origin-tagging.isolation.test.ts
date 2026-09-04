/**
 * Isolation tests for docs/specs/hosted-ticket-create-handoff.md R7 /
 * docs/specs/third-party-api-origin-tagging.md R2: POST /entities' optional
 * appClientId param (sent only by the hosted handoff flow) must resolve to a
 * real, active, non-revoked api_keys row before creation is allowed, and the
 * resulting entity is tagged with origin_mechanism='handoff'.
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { db, tenants, apiKeys, entityInstances } from "@platform/db";
import { createEntityType } from "@platform/entity-engine";
import { hashApiKey } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { createEntityHandler } from "../../src/routes/entities/create.js";

const TENANT = "aabbccdd-0000-4000-a000-000000000090";
const ACTIVE_KEY_ID = "90000000-9000-4000-9000-000000000001";
const REVOKED_KEY_ID = "90000000-9000-4000-9000-000000000002";
const ACTIVE_CLIENT_ID = "handoff-origin-test-active-client";
const REVOKED_CLIENT_ID = "handoff-origin-test-revoked-client";

let entityTypeId: string;
const createdInstanceIds: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Handoff Origin Tagging Test",
    slug: `handoff-origin-tagging-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `handoff_origin_tagging_test_${Date.now()}`,
    plural: "handoff_origin_tagging_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  await db.insert(apiKeys).values([
    {
      id: ACTIVE_KEY_ID,
      tenantId: TENANT,
      name: "Handoff Origin Test Active Key",
      keyHash: hashApiKey(`sk_handoff_origin_active_${TENANT}`),
      scopesFormat: "action",
      scopes: ["entity:ticket:create"],
      oidcClientId: ACTIVE_CLIENT_ID,
    },
    {
      id: REVOKED_KEY_ID,
      tenantId: TENANT,
      name: "Handoff Origin Test Revoked Key",
      keyHash: hashApiKey(`sk_handoff_origin_revoked_${TENANT}`),
      scopesFormat: "action",
      scopes: ["entity:ticket:create"],
      oidcClientId: REVOKED_CLIENT_ID,
      revokedAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  for (const id of createdInstanceIds) {
    await db.delete(entityInstances).where(eq(entityInstances.id, id));
  }
  await db.delete(apiKeys).where(eq(apiKeys.id, ACTIVE_KEY_ID));
  await db.delete(apiKeys).where(eq(apiKeys.id, REVOKED_KEY_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

type Vars = { Variables: { auth: AuthContext } };

function makeApp() {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "handoff-origin-test-user",
      tenantId: TENANT,
      roles: ["user"],
      email: "handoff-origin-test@example.com",
      displayName: "Handoff Origin Test User",
      orgId: "org-090",
    });
    await next();
  });
  app.post("/", ...createEntityHandler);
  return app;
}

describe("POST /entities appClientId validation (docs/specs/hosted-ticket-create-handoff.md R7)", () => {
  it("creates and tags the entity with origin_mechanism='handoff' when appClientId resolves to a real, active key", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId,
        fields: {},
        appClientId: ACTIVE_CLIENT_ID,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    createdInstanceIds.push(body.data.id);

    const [row] = await db
      .select({
        originMechanism: entityInstances.originMechanism,
        originOidcClientId: entityInstances.originOidcClientId,
        originPerformerUserId: entityInstances.originPerformerUserId,
      })
      .from(entityInstances)
      .where(eq(entityInstances.id, body.data.id));

    expect(row?.originMechanism).toBe("handoff");
    expect(row?.originOidcClientId).toBe(ACTIVE_CLIENT_ID);
    expect(row?.originPerformerUserId).toBe("handoff-origin-test-user");
  });

  it("creates a normal, untagged entity when appClientId is omitted entirely", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId, fields: {} }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    createdInstanceIds.push(body.data.id);

    const [row] = await db
      .select({ originMechanism: entityInstances.originMechanism })
      .from(entityInstances)
      .where(eq(entityInstances.id, body.data.id));

    expect(row?.originMechanism).toBeNull();
  });

  it("rejects creation outright with an unregistered/fabricated appClientId — no entity row is created", async () => {
    const before = await db
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(eq(entityInstances.entityTypeId, entityTypeId));

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId,
        fields: {},
        appClientId: "not-a-real-registered-client-id",
      }),
    });
    expect(res.status).toBe(422);

    const after = await db
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(eq(entityInstances.entityTypeId, entityTypeId));
    expect(after.length).toBe(before.length);
  });

  it("rejects creation outright with a revoked key's appClientId", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId,
        fields: {},
        appClientId: REVOKED_CLIENT_ID,
      }),
    });
    expect(res.status).toBe(422);
  });
});
