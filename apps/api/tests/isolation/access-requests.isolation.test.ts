/**
 * Isolation + Prove-It tests for the access-request review findings (PR #144
 * review round 2):
 *
 * - C-1: access_requests was missing GRANT SELECT/INSERT/UPDATE for app_user
 *   (migration 0032) — every route using withTenantContext (SET LOCAL ROLE
 *   app_user) got "permission denied for table access_requests". Proven here
 *   by exercising the routes against a real Postgres connection with RLS +
 *   app_user enforced (not mocked).
 * - IMP-2: request-access.ts's pending-row lookup used to grab the oldest
 *   row via ORDER BY createdAt ASC LIMIT 1, which after a second rejection
 *   returned a resolved row instead of the real pending one, causing a
 *   unique-constraint 500. Reproduced end-to-end with a real reject cycle.
 * - IMP-3: resolve-access-request.ts used to have no pending-status guard,
 *   so rejecting an already-approved request silently left access granted.
 * - H-4: resolve-access-request.ts's UPDATE on access_requests was missing
 *   an explicit tenant_id filter (RLS was the only guard).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  entityTypes,
  entityInstances,
  accessRequests,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { requestAccessHandler } from "../../src/routes/entities/request-access.js";
import { listAccessRequestsHandler } from "../../src/routes/entities/list-access-requests.js";
import { resolveAccessRequestHandler } from "../../src/routes/entities/resolve-access-request.js";

const TENANT = "dddddddd-0000-4000-d000-000000000144";
const OWNER = "isolation-owner";
const REQUESTER = "isolation-requester";

let instanceId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Isolation Test Tenant 144",
    slug: `isolation-144-${Date.now()}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `isolation_access_req_ticket_${Date.now()}`,
    plural: "isolation_access_req_tickets",
    allowCustomFields: true,
  });

  const instance = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: OWNER,
  });
  instanceId = instance.id;
});

afterAll(async () => {
  // access_requests intentionally has no DELETE grant for app_user (C-1's
  // fix only adds SELECT/INSERT/UPDATE, matching the reviewer's exact
  // request) — clean up via the superuser db connection instead.
  await db.delete(accessRequests).where(eq(accessRequests.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

function makeApp(userId: string, roles: string[] = ["user"]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId: TENANT, userId, roles, email: "t@test.dev" });
      await next();
    },
  );
  app.post("/:id/access-requests", ...requestAccessHandler);
  app.get("/:id/access-requests", ...listAccessRequestsHandler);
  app.post(
    "/:id/access-requests/:reqId/resolve",
    ...resolveAccessRequestHandler,
  );
  return app;
}

describe("access_requests — C-1 grant + IMP-2/IMP-3/H-4", () => {
  it("C-1: POST /access-requests succeeds against real Postgres+RLS (previously 'permission denied for table access_requests')", async () => {
    const res = await makeApp(REQUESTER).request(
      `/${instanceId}/access-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedLevel: "read_comment" }),
      },
    );

    expect(res.status).toBe(201);
  });

  it("C-1/H-4: owner can list and resolve (approve) the request; UPDATE is tenant-scoped", async () => {
    const [pending] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.tenantId, TENANT),
            eq(accessRequests.instanceId, instanceId),
            eq(accessRequests.status, "pending"),
          ),
        ),
    );
    expect(pending).toBeDefined();

    const listRes = await makeApp(OWNER).request(
      `/${instanceId}/access-requests`,
    );
    expect(listRes.status).toBe(200);

    const resolveRes = await makeApp(OWNER).request(
      `/${instanceId}/access-requests/${pending!.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    expect(resolveRes.status).toBe(200);
  });

  it("IMP-3: resolving the same request again is rejected with 422, not silently re-applied", async () => {
    const [resolved] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.tenantId, TENANT),
            eq(accessRequests.instanceId, instanceId),
            eq(accessRequests.requesterId, REQUESTER),
          ),
        ),
    );
    expect(resolved!.status).toBe("approved");

    const res = await makeApp(OWNER).request(
      `/${instanceId}/access-requests/${resolved!.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      },
    );
    expect(res.status).toBe(422);

    const [stillApproved] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(accessRequests)
        .where(eq(accessRequests.id, resolved!.id)),
    );
    expect(stillApproved!.status).toBe("approved");
  });

  it("IMP-2: a second request/reject cycle for the same user finds the real pending row instead of 500ing on the unique constraint", async () => {
    const secondRequester = "isolation-requester-2";

    // First request, then reject it.
    const firstRes = await makeApp(secondRequester).request(
      `/${instanceId}/access-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedLevel: "read_only" }),
      },
    );
    expect(firstRes.status).toBe(201);
    const { data: first } = (await firstRes.json()) as { data: { id: string } };

    await makeApp(OWNER).request(
      `/${instanceId}/access-requests/${first.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      },
    );

    // Second request for the same user — must succeed (201), not 500.
    const secondRes = await makeApp(secondRequester).request(
      `/${instanceId}/access-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedLevel: "read_comment" }),
      },
    );
    expect(secondRes.status).toBe(201);

    // Reject again — the bug (ORDER BY createdAt ASC LIMIT 1) would have
    // grabbed the first (already-rejected) row here and missed the real
    // pending one, causing the *third* request below to 500.
    const { data: second } = (await secondRes.json()) as {
      data: { id: string };
    };
    await makeApp(OWNER).request(
      `/${instanceId}/access-requests/${second.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      },
    );

    const thirdRes = await makeApp(secondRequester).request(
      `/${instanceId}/access-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedLevel: "read_write" }),
      },
    );
    expect(thirdRes.status).toBe(201);
  });
});
