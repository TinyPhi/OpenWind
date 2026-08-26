/**
 * Isolation test for ADR-012 Phase G, spec R1 — the per-(key,person)
 * rate-limit tier, exercised through a real third-party route
 * (comments.ts) with real Redis. Rather than firing 20+ real requests to
 * exhaust the threshold, the underlying Redis counter is seeded directly
 * to one-under-threshold, then a single real request tips it over.
 *
 * The per-key AGGREGATE tier and the per-tenant tier both live inside
 * @platform/auth's requireAuth (packages/auth/src/middleware.ts) -- every
 * third-party isolation test in this repo (including this one) stubs
 * `auth` directly via a pre-population middleware, matching this repo's
 * established convention that these tests target a ROUTE's own
 * access-list/scope gating, not requireAuth's JWT/API-key verification
 * (unit-tested separately). requireAuth's own short-circuit
 * (`if (c.get("auth")) { await next(); return; }`) means its internal
 * checks, including the per-key aggregate tier, never run under that stub
 * -- so that tier is covered by packages/auth/src/middleware.test.ts's
 * unit tests instead, not here.
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). Real
 * Redis connection for the counter under test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import { db, tenants, workflows, workflowStates } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import { getRedis } from "@platform/redis";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";

const TENANT = "ddeeff00-0000-4000-d000-000000000f01";

let ticketId: string;

const PERSON_A = "rate-limit-tier-person-a";
const PERSON_B = "rate-limit-tier-person-b";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Rate Limit Tiers Tenant",
    slug: `rate-limit-tiers-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `rate_limit_tiers_test_${Date.now()}`,
    plural: "rate_limit_tiers_tests",
    allowCustomFields: true,
  });

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId: entityType.id,
      name: "Rate Limit Tiers Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });

  await db.insert(workflowStates).values({
    tenantId: TENANT,
    workflowId: workflow!.id,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });

  const ticket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: PERSON_A,
    workflowId: workflow!.id,
    currentState: "open",
  });
  ticketId = ticket.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  const redis = getRedis();
  const keys = await redis.keys(`rl:*${TENANT}*`);
  if (keys.length > 0) await redis.del(...keys);
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(apiKeyId: string, actingPersonId: string) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: `apikey:${apiKeyId}`,
      tenantId: TENANT,
      roles: ["entity:ticket:comment"],
      email: "",
      displayName: "API Key",
      orgId: "org-ratelimit",
    });
    c.set("actingPerson", {
      userId: actingPersonId,
      email: `${actingPersonId}@example.com`,
      displayName: actingPersonId,
      orgId: "org-ratelimit",
    });
    await next();
  });
  app.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
  return app;
}

async function postComment(app: Hono<Vars>) {
  return app.request(`/tickets/${ticketId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
}

describe("Phase G, spec R1 — per-(key,person) rate-limit tier", () => {
  it("rejects once the 20/min per-(key,person) tier is exceeded, independent of other people on the same key", async () => {
    const apiKeyId = "11111111-1111-4111-1111-111111111111";
    const redis = getRedis();
    const key = `rl:key-person:${TENANT}:${apiKeyId}:${PERSON_A}`;
    // Seed to one-under-threshold (limit 20) so the next real request tips it over.
    for (let i = 0; i < 20; i++) {
      await redis.zadd(key, Date.now(), `seed-${i}-${Math.random()}`);
    }
    await redis.expire(key, 60);

    const app = makeApp(apiKeyId, PERSON_A);
    const res = await postComment(app);
    expect(res.status).toBe(429);

    // A different person on the SAME key is unaffected -- independent bucket.
    const appOtherPerson = makeApp(apiKeyId, PERSON_B);
    const resOtherPerson = await postComment(appOtherPerson);
    expect(resOtherPerson.status).toBe(201);

    await redis.del(key);
  });
});
