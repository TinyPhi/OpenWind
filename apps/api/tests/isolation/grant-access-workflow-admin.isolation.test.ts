/**
 * Isolation test for issue #167: grant-access.ts was the only ACL-mutation
 * route missing the isPrivileged/isRecordWorkflowAdmin check already present
 * in revoke-access.ts/update-access.ts/resolve-access-request.ts (see
 * ADR-006). A workflow admin (role "user", createdBy/assignedTo on the
 * workflow) could approve a requested grant via resolve-access-request.ts but
 * could not issue a direct grant the same way via grant-access.ts. Exercises
 * the exact scenario end-to-end against real Postgres + RLS.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  tenantUsers,
  entityTypes,
  entityInstances,
  workflows,
  workflowStates,
  workflowEvents,
} from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { createWorkflow } from "@platform/workflow-engine";
import type { AuthContext } from "@platform/auth";
import { grantAccessHandler } from "../../src/routes/entities/grant-access.js";

const TENANT = "dddddddd-0000-4000-d000-000000000167";
const WORKFLOW_ADMIN = "isolation-workflow-admin-167";
const RANDOM_USER = "isolation-random-user-167";
const TARGET_USER = "isolation-target-167";

let instanceId: string;
let workflowId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Isolation Test Tenant 167",
    slug: `isolation-167-${Date.now()}`,
  });

  // Tenant membership is required by grant-access.ts's target-userId check.
  await db.insert(tenantUsers).values([
    { tenantId: TENANT, userId: WORKFLOW_ADMIN },
    { tenantId: TENANT, userId: RANDOM_USER },
    { tenantId: TENANT, userId: TARGET_USER },
  ]);

  const [entityType] = await db
    .insert(entityTypes)
    .values({
      tenantId: TENANT,
      name: `isolation_grant_access_ticket_${Date.now()}`,
      plural: "isolation_grant_access_tickets",
      allowCustomFields: true,
    })
    .returning();
  if (!entityType) throw new Error("failed to create entity type");

  const workflow = await createWorkflow(db, TENANT, WORKFLOW_ADMIN, {
    entityTypeId: entityType.id,
    name: `isolation_grant_access_workflow_${Date.now()}`,
    initialState: "open",
  });
  workflowId = workflow.id;

  await db.insert(workflowStates).values({
    tenantId: TENANT,
    workflowId: workflow.id,
    name: "open",
    label: "Open",
  });

  const instance = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    workflowId: workflow.id,
    fields: {},
    createdBy: "isolation-record-owner-167",
  });
  instanceId = instance.id;
});

afterAll(async () => {
  // grant-access.ts fires `void emitAccessEvent(...)` without awaiting it, so its
  // async workflow_events insert can still be in flight here, landing after this
  // delete and blocking the entity_instances delete below with a 23503 FK
  // violation. Retry a few times rather than making the route await it — the
  // fire-and-forget behavior is intentional (route response must not block on it).
  for (let attempt = 1; ; attempt++) {
    await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
    try {
      await db
        .delete(entityInstances)
        .where(eq(entityInstances.tenantId, TENANT));
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenantUsers).where(eq(tenantUsers.tenantId, TENANT));
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
  app.post("/:id/access", ...grantAccessHandler);
  return app;
}

describe("grant-access.ts — workflow-admin direct grant (issue #167)", () => {
  it("a workflow admin (role user, not tenant admin/agent) can issue a direct grant", async () => {
    const res = await makeApp(WORKFLOW_ADMIN).request(`/${instanceId}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TARGET_USER, level: "read_write" }),
    });

    expect(res.status).toBe(201);

    const [row] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ fields: entityInstances.fields })
        .from(entityInstances)
        .where(eq(entityInstances.id, instanceId)),
    );
    const accessUsers = (row?.fields as Record<string, unknown>)
      ?.__accessUsers as Record<string, { level: string }> | undefined;
    expect(accessUsers?.[TARGET_USER]?.level).toBe("read_write");
  });

  it("an unrelated user role (not owner, not workflow admin) gets 404, not the grant", async () => {
    const res = await makeApp(RANDOM_USER).request(`/${instanceId}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TARGET_USER, level: "read_write" }),
    });

    expect(res.status).toBe(404);
  });
});
