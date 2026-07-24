/**
 * Isolation + Prove-It tests for the child-ticket route surface (PR #144
 * review round 2, M-4: "no isolation tests for child-ticket routes").
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 *
 * Also proves IMP-6 (child creation emits entity.created to the outbox —
 * PR #138's fix didn't cover createChildRelation) and H-3 (set-child-status
 * restricted to admin/agent only, no owner/assignee/ACL side-door).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  entityTypes,
  entityInstances,
  entityRelations,
  outboxEvents,
  workflows,
  workflowStates,
  workflowEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { createChildHandler } from "../../src/routes/entities/create-child.js";
import { listChildrenHandler } from "../../src/routes/entities/list-children.js";
import { setChildStatusHandler } from "../../src/routes/entities/set-child-status.js";
import { moveParentHandler } from "../../src/routes/entities/move-parent.js";

const TENANT = "eeeeeeee-0000-4000-e000-000000000144";
const OTHER_USER = "isolation-outsider";

let parentId: string;
let entityTypeId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Isolation Child-Ticket Tenant",
    slug: `isolation-child-144-${Date.now()}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `isolation_child_ticket_${Date.now()}`,
    plural: "isolation_child_tickets",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "Isolation child-ticket workflow",
      initialState: "open",
      maxChildDepth: 1,
      maxChildrenPerParent: 10,
    })
    .returning({ id: workflows.id });

  await db.insert(workflowStates).values([
    {
      tenantId: TENANT,
      workflowId: workflow!.id,
      name: "open",
      label: "Open",
      sortOrder: 0,
    },
    {
      tenantId: TENANT,
      workflowId: workflow!.id,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);

  const parent = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "isolation-parent-owner",
    workflowId: workflow!.id,
    currentState: "open",
  });
  parentId = parent.id;
});

afterAll(async () => {
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
  await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
  await db.delete(entityRelations).where(eq(entityRelations.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  const workflowRows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.tenantId, TENANT));
  for (const w of workflowRows) {
    await db.delete(workflowStates).where(eq(workflowStates.workflowId, w.id));
  }
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

function makeApp(userId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId: TENANT, userId, roles, email: "t@test.dev" });
      await next();
    },
  );
  app.post("/:id/children", ...createChildHandler);
  app.get("/:id/children", ...listChildrenHandler);
  app.patch("/:id/child-status", ...setChildStatusHandler);
  app.patch("/:id/parent", ...moveParentHandler);
  return app;
}

describe("child-ticket routes — real Postgres, RLS enforced", () => {
  let childId: string;

  it("POST /:id/children creates a child and emits entity.created to the outbox (IMP-6)", async () => {
    const res = await makeApp("isolation-agent", ["agent"]).request(
      `/${parentId}/children`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityTypeId, fields: { title: "Sub-task" } }),
      },
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { instance: { id: string } };
    };
    childId = data.instance.id;

    const [outboxRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "entity.created"),
            sql`${outboxEvents.payload}->>'instanceId' = ${childId}`,
          ),
        ),
    );
    expect(outboxRow).toBeDefined();
  });

  it("GET /:id/children (on the parent) returns the created child — gated by hasEntityReadAccess (C-2)", async () => {
    const res = await makeApp("isolation-parent-owner", ["user"]).request(
      `/${parentId}/children`,
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.some((row) => row.id === childId)).toBe(true);
  });

  it("GET /:id/children returns 404 for a user with no relation to the parent (C-2)", async () => {
    const res = await makeApp(OTHER_USER, ["user"]).request(
      `/${parentId}/children`,
    );
    expect(res.status).toBe(404);
  });

  it("H-3: PATCH /:id/child-status rejects a plain user role even as parent owner", async () => {
    const res = await makeApp("isolation-parent-owner", ["user"]).request(
      `/${childId}/child-status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("H-3: PATCH /:id/child-status succeeds for admin/agent", async () => {
    const res = await makeApp("isolation-agent", ["agent"]).request(
      `/${childId}/child-status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      },
    );
    expect(res.status).toBe(200);

    const [row] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ currentState: entityInstances.currentState })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, childId),
            eq(entityInstances.tenantId, TENANT),
          ),
        ),
    );
    expect(row?.currentState).toBe("closed");
  });

  it("PATCH /:id/parent detaches the child when parentId is null", async () => {
    const res = await makeApp("isolation-agent", ["agent"]).request(
      `/${childId}/parent`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: null }),
      },
    );
    expect(res.status).toBe(200);

    const remaining = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.tenantId, TENANT),
            eq(entityRelations.fromInstanceId, childId),
          ),
        ),
    );
    expect(remaining.every((r) => r.deletedAt !== null)).toBe(true);
  });
});
