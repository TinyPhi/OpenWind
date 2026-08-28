/**
 * Isolation tests for ADR-012 Phase F, spec R4 — misuse-alert triggers 1
 * (repeated scope-denial) and 2 (request-volume spike), exercised through
 * the real requireTicketScope middleware (real Redis, real Postgres outbox
 * table). Trigger 3 (tagging-grant-cap) is covered by
 * apps/worker/src/mention-resolution-worker.test.ts's unit test, since it
 * fires from an existing, already-isolation-tested worker code path.
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). Real
 * Redis connection for the counters under test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  outboxEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import { getRedis } from "@platform/redis";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";

const TENANT = "ccddeeff-0000-4000-c000-000000000f01";
const OTHER_TENANT = "ccddeeff-0000-4000-c000-000000000f02";
const NO_SCOPE_ACTOR_ID = "99999999-9999-4999-9999-999999999999";
const VOLUME_ACTOR_ID = "77777777-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

let ticketId: string;
let otherTenantTicketId: string;

const ACTING_PERSON = "misuse-alerts-person";

async function seedTenant(tenantId: string) {
  await db.insert(tenants).values({
    id: tenantId,
    name: `Misuse Alerts Tenant ${tenantId}`,
    slug: `misuse-alerts-${tenantId}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `misuse_alerts_test_${tenantId}_${Date.now()}`,
    plural: `misuse_alerts_tests_${tenantId.slice(-4)}`,
    allowCustomFields: true,
  });

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId,
      entityTypeId: entityType.id,
      name: `Misuse Alerts Workflow ${tenantId}`,
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
    createdBy: ACTING_PERSON,
    workflowId: workflow!.id,
    currentState: "open",
  });

  return {
    entityTypeId: entityType.id,
    workflowId: workflow!.id,
    ticketId: ticket.id,
  };
}

beforeAll(async () => {
  const main = await seedTenant(TENANT);
  ticketId = main.ticketId;

  const other = await seedTenant(OTHER_TENANT);
  otherTenantTicketId = other.ticketId;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
  const redis = getRedis();
  const keys = await redis.keys(`misuse:*`);
  const relevant = keys.filter(
    (k) => k.includes(TENANT) || k.includes(OTHER_TENANT),
  );
  if (relevant.length > 0) await redis.del(...relevant);
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(
  tenantId: string,
  applicationActorId: string,
  scopes: string[],
) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: `apikey:${applicationActorId}`,
      tenantId,
      roles: scopes,
      email: "",
      displayName: "API Key",
      orgId: "org-misuse",
    });
    c.set("actingPerson", {
      userId: ACTING_PERSON,
      email: `${ACTING_PERSON}@example.com`,
      displayName: ACTING_PERSON,
      orgId: "org-misuse",
    });
    await next();
  });
  app.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
  return app;
}

async function postComment(app: Hono<Vars>, targetTicketId: string) {
  return app.request(`/tickets/${targetTicketId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
}

async function alertCount(
  tenantId: string,
  applicationActorId: string,
  trigger: string,
): Promise<number> {
  const rows = await db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.tenantId, tenantId),
        eq(outboxEvents.eventType, "system.error"),
        sql`${outboxEvents.payload}->'context'->>'trigger' = ${trigger}`,
        sql`${outboxEvents.payload}->'context'->>'applicationActorId' = ${applicationActorId}`,
      ),
    );
  return rows.length;
}

describe("Phase F, spec R4 trigger 1 — repeated scope-denial alert", () => {
  it("does not fire under 9 denials, fires exactly once at the 10th, and never again after", async () => {
    const app = makeApp(TENANT, NO_SCOPE_ACTOR_ID, []); // no entity:ticket:comment scope

    for (let i = 0; i < 9; i++) {
      const res = await postComment(app, ticketId);
      expect(res.status).toBe(403);
    }
    expect(
      await alertCount(TENANT, NO_SCOPE_ACTOR_ID, "auth_failure_rate"),
    ).toBe(0);

    const tenthRes = await postComment(app, ticketId);
    expect(tenthRes.status).toBe(403);
    expect(
      await alertCount(TENANT, NO_SCOPE_ACTOR_ID, "auth_failure_rate"),
    ).toBe(1);

    for (let i = 0; i < 5; i++) {
      await postComment(app, ticketId);
    }
    expect(
      await alertCount(TENANT, NO_SCOPE_ACTOR_ID, "auth_failure_rate"),
    ).toBe(1);
  });

  // Tenant isolation (security-reviewer finding): the Redis counter key
  // includes tenantId before applicationActorId -- prove that literally, by
  // reusing the SAME applicationActorId in both tenants and confirming each
  // tenant's count/alert is entirely independent of the other's activity.
  it("scopes the counter and the alert by tenant, even for the same applicationActorId", async () => {
    const sharedActorId = "shared-actor-cross-tenant";
    const appA = makeApp(TENANT, sharedActorId, []);
    const appB = makeApp(OTHER_TENANT, sharedActorId, []);

    // 9 denials in tenant A, 9 denials in tenant B, interleaved -- if the
    // counter were keyed only by applicationActorId, this would already have
    // hit 18 and fired, or fired on tenant A's 9th visible-to-B increment.
    for (let i = 0; i < 9; i++) {
      await postComment(appA, ticketId);
      await postComment(appB, otherTenantTicketId);
    }
    expect(await alertCount(TENANT, sharedActorId, "auth_failure_rate")).toBe(
      0,
    );
    expect(
      await alertCount(OTHER_TENANT, sharedActorId, "auth_failure_rate"),
    ).toBe(0);

    // Tenant A's 10th denial fires ONLY tenant A's alert.
    await postComment(appA, ticketId);
    expect(await alertCount(TENANT, sharedActorId, "auth_failure_rate")).toBe(
      1,
    );
    expect(
      await alertCount(OTHER_TENANT, sharedActorId, "auth_failure_rate"),
    ).toBe(0);

    // Tenant B's own 10th denial fires its own, independent alert.
    await postComment(appB, otherTenantTicketId);
    expect(
      await alertCount(OTHER_TENANT, sharedActorId, "auth_failure_rate"),
    ).toBe(1);
    expect(await alertCount(TENANT, sharedActorId, "auth_failure_rate")).toBe(
      1,
    );
  });
});

describe("Phase F, spec R4 trigger 2 — request-volume spike alert", () => {
  it("fires once after seeding 24h of baseline history and crossing 5x in the current hour", async () => {
    const redis = getRedis();
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const baselineKeys: string[] = [];
    for (let i = 1; i <= 24; i++) {
      const key = `misuse:volume:${TENANT}:${VOLUME_ACTOR_ID}:${hourBucket - i}`;
      await redis.set(key, "2", "EX", 3600 * 200);
      baselineKeys.push(key);
    }

    const app = makeApp(TENANT, VOLUME_ACTOR_ID, ["entity:ticket:comment"]);
    // baseline = 2, threshold = 10 -> 11 requests this hour should cross it
    for (let i = 0; i < 11; i++) {
      const res = await postComment(app, ticketId);
      expect(res.status).toBe(201);
    }
    expect(await alertCount(TENANT, VOLUME_ACTOR_ID, "volume_spike")).toBe(1);

    // Further requests in the same hour must not re-fire.
    for (let i = 0; i < 5; i++) {
      await postComment(app, ticketId);
    }
    expect(await alertCount(TENANT, VOLUME_ACTOR_ID, "volume_spike")).toBe(1);

    await redis.del(...baselineKeys);
  });
});
