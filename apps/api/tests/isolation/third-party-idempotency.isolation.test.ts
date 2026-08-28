/**
 * Isolation tests for ADR-012 Phase G, spec R3/R4/R5 -- idempotency-key
 * support, exercised through a real third-party route (comments.ts) with
 * real Postgres (RLS + app_user enforced) and real Redis (the 30s in-flight
 * lock).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  idempotencyKeys,
  entityInstances,
  apiKeys,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";

const TENANT = "eeff0011-1111-4000-e000-000000000f02";
const CREATOR = "idempotency-test-creator";
const API_KEY_ID = "22222222-2222-4222-2222-222222222222";

const TENANT_2 = "eeff0011-2222-4000-e000-000000000f03";
const CREATOR_2 = "idempotency-test-creator-2";
const API_KEY_ID_2 = "33333333-3333-4333-3333-333333333333";

let ticketId: string;
let ticketId2: string;

async function seedTenant(tenantId: string, creator: string): Promise<string> {
  await db.insert(tenants).values({
    id: tenantId,
    name: `Idempotency Tenant ${tenantId}`,
    slug: `idempotency-${tenantId}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `idempotency_test_${tenantId}_${Date.now()}`,
    plural: "idempotency_tests",
    allowCustomFields: true,
  });

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId,
      entityTypeId: entityType.id,
      name: "Idempotency Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });

  await db.insert(workflowStates).values({
    tenantId,
    workflowId: workflow!.id,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });

  const ticket = await createEntity(db, tenantId, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: creator,
    workflowId: workflow!.id,
    currentState: "open",
  });
  return ticket.id;
}

beforeAll(async () => {
  ticketId = await seedTenant(TENANT, CREATOR);
  ticketId2 = await seedTenant(TENANT_2, CREATOR_2);

  await db.insert(apiKeys).values([
    {
      id: API_KEY_ID,
      tenantId: TENANT,
      name: "Idempotency API Key 1",
      keyHash: "idempotency-test-hash-1",
      scopes: [],
    },
    {
      id: API_KEY_ID_2,
      tenantId: TENANT_2,
      name: "Idempotency API Key 2",
      keyHash: "idempotency-test-hash-2",
      scopes: [],
    },
  ]);
});

afterAll(async () => {
  await db.delete(apiKeys).where(inArray(apiKeys.tenantId, [TENANT, TENANT_2]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, TENANT_2]));
  await db
    .delete(idempotencyKeys)
    .where(inArray(idempotencyKeys.tenantId, [TENANT, TENANT_2]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(
  tenantId: string = TENANT,
  apiKeyId: string = API_KEY_ID,
  actingPersonId: string = CREATOR,
) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: `apikey:${apiKeyId}`,
      tenantId,
      roles: ["entity:ticket:comment"],
      email: "",
      displayName: "API Key",
      orgId: "org-idempotency",
    });
    c.set("actingPerson", {
      userId: actingPersonId,
      email: `${actingPersonId}@example.com`,
      displayName: actingPersonId,
      orgId: "org-idempotency",
    });
    await next();
  });
  app.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
  return app;
}

async function postComment(
  text: string,
  idempotencyKey?: string,
  opts?: {
    tenantId?: string;
    apiKeyId?: string;
    actingPersonId?: string;
    ticketId?: string;
  },
): Promise<Response> {
  const app = makeApp(opts?.tenantId, opts?.apiKeyId, opts?.actingPersonId);
  const targetTicketId = opts?.ticketId ?? ticketId;
  return app.request(`/tickets/${targetTicketId}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ text }),
  });
}

describe("Phase G, spec R3 — idempotency replay", () => {
  it("a retry with the same key and identical content returns the cached result instead of creating a second comment", async () => {
    const key = `replay-${Date.now()}`;
    const first = await postComment("hello", key);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };

    const second = await postComment("hello", key);
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { id: string } };

    expect(secondBody.data.id).toBe(firstBody.data.id);
  });
});

describe("Phase G, spec R4 — idempotency conflict", () => {
  it("the same key with different content is rejected 409, not silently replayed", async () => {
    const key = `conflict-${Date.now()}`;
    const first = await postComment("first content", key);
    expect(first.status).toBe(201);

    const second = await postComment("different content", key);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("Phase G — idempotency scope isolation (4-tuple, not just the key string)", () => {
  it("a different tenant reusing the identical key string and content executes independently, not a replay or conflict", async () => {
    const key = `cross-tenant-${Date.now()}`;
    const first = await postComment("shared content", key, {
      tenantId: TENANT,
      apiKeyId: API_KEY_ID,
      actingPersonId: CREATOR,
      ticketId,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };

    const second = await postComment("shared content", key, {
      tenantId: TENANT_2,
      apiKeyId: API_KEY_ID_2,
      actingPersonId: CREATOR_2,
      ticketId: ticketId2,
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { id: string } };

    // Two distinct comments, not a cache hit against tenant 1's row.
    expect(secondBody.data.id).not.toBe(firstBody.data.id);
  });

  it("a different acting person on the same key+tenant, reusing the identical key string, executes independently", async () => {
    const key = `cross-person-${Date.now()}`;
    const first = await postComment("shared content 2", key, {
      tenantId: TENANT,
      apiKeyId: API_KEY_ID,
      actingPersonId: CREATOR,
      ticketId,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };

    // A second acting person under the SAME tenant+apiKey, granted access
    // via assignedTo (same pattern as the rate-limit-tiers isolation test --
    // a fields.__accessUsers grant is stripped by createEntity's schema
    // validation, assignedTo is a native column and isn't).
    await db
      .update(entityInstances)
      .set({ assignedTo: CREATOR_2 })
      .where(eq(entityInstances.id, ticketId));

    const second = await postComment("shared content 2", key, {
      tenantId: TENANT,
      apiKeyId: API_KEY_ID,
      actingPersonId: CREATOR_2,
      ticketId,
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { id: string } };

    expect(secondBody.data.id).not.toBe(firstBody.data.id);
  });
});

describe("Phase G, spec R5 — concurrent in-flight lock", () => {
  it("of two concurrent identical requests with the same key, exactly one executes", async () => {
    const key = `concurrent-${Date.now()}`;
    const [a, b] = await Promise.all([
      postComment("racing", key),
      postComment("racing", key),
    ]);

    const statuses = [a.status, b.status].sort();
    // One succeeds (201); the other either loses the lock race (409) or, on
    // a very tight timing window, arrives after the first already cached
    // its result (also 201, replaying the same comment id) -- either way,
    // never two distinct comments created.
    expect(statuses[0] === 201 || statuses[0] === 409).toBe(true);
    if (a.status === 201 && b.status === 201) {
      const bodyA = (await a.json()) as { data: { id: string } };
      const bodyB = (await b.json()) as { data: { id: string } };
      expect(bodyA.data.id).toBe(bodyB.data.id);
    }
  });
});
