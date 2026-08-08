/**
 * Isolation tests for the v1.1 sections of GET /dashboard/my-view
 * (docs/specs/personal-dashboard.md R10-R12): adminWorkflows, savedViews,
 * pendingApprovals. Tests run against a real Postgres instance (no mocks).
 *
 * Rows are seeded directly via `db` (bypassing the API/engine, DB-owner
 * connection bypasses RLS for setup) — same pattern as
 * saved-views.isolation.test.ts and dashboard-my-view.isolation.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  workflows,
  savedViews,
  accessRequests,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { myViewHandler } from "../../src/routes/dashboard/my-view.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000061";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000062";

const USER_A_ADMIN = "user-a-admin-v11-test"; // administers WORKFLOW_A (createdBy)
const USER_A_ASSIGNED_ADMIN = "user-a-assigned-admin-v11-test"; // administers WORKFLOW_A (assignedTo)
const USER_A_PLAIN = "user-a-plain-v11-test"; // administers nothing
const USER_B_ADMIN = "user-b-admin-v11-test"; // administers WORKFLOW_B, Tenant B

let entityTypeId: string;
let workflowAId: string;
let workflowBId: string;
let ticketAId: string; // Tenant A ticket under WORKFLOW_A, for the access request
let requestOnAId: string; // pending access_requests row on ticketA

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "V11 Isolation Tenant A",
      slug: `v11-iso-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "V11 Isolation Tenant B",
      slug: `v11-iso-b-${Date.now()}`,
    },
  ]);

  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_v11_${Date.now()}`,
      plural: `isolation_v11s_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const [wfA] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_A,
      entityTypeId,
      name: "V11 Workflow A",
      initialState: "open",
      createdBy: USER_A_ADMIN,
      assignedTo: [USER_A_ADMIN, USER_A_ASSIGNED_ADMIN],
    })
    .returning();
  if (!wfA) throw new Error("workflow A insert failed");
  workflowAId = wfA.id;

  const [wfB] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_B,
      entityTypeId,
      name: "V11 Workflow B",
      initialState: "open",
      createdBy: USER_B_ADMIN,
      assignedTo: [USER_B_ADMIN],
    })
    .returning();
  if (!wfB) throw new Error("workflow B insert failed");
  workflowBId = wfB.id;

  const [ticketA] = await db
    .insert(entityInstances)
    .values({
      entityTypeId,
      tenantId: TENANT_A,
      workflowId: workflowAId,
      currentState: "open",
      fields: { title: "Needs access review" },
      createdBy: "some-requester-owner",
    })
    .returning();
  if (!ticketA) throw new Error("ticket insert failed");
  ticketAId = ticketA.id;

  const [req] = await db
    .insert(accessRequests)
    .values({
      tenantId: TENANT_A,
      instanceId: ticketAId,
      requesterId: "requester-user-v11-test",
      requestedLevel: "read_comment",
      status: "pending",
    })
    .returning();
  if (!req) throw new Error("access request insert failed");
  requestOnAId = req.id;

  await db.insert(savedViews).values([
    {
      tenantId: TENANT_A,
      userId: USER_A_PLAIN,
      entityTypeId,
      name: "V11 My Saved View",
      filterConfig: {},
      sortConfig: {},
      isDefault: false,
    },
    {
      tenantId: TENANT_A,
      userId: USER_A_ADMIN,
      entityTypeId,
      name: "Other User's Saved View",
      filterConfig: {},
      sortConfig: {},
      isDefault: false,
    },
  ]);
});

afterAll(async () => {
  await db.delete(accessRequests).where(eq(accessRequests.id, requestOnAId));
  await db.delete(savedViews).where(eq(savedViews.entityTypeId, entityTypeId));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(workflows).where(eq(workflows.id, workflowAId));
  await db.delete(workflows).where(eq(workflows.id, workflowBId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

function makeApp(tenantId: string, userId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: ["user"],
        email: "t@example.com",
      });
      await next();
    },
  );
  app.get("/my-view", ...myViewHandler);
  return app;
}

type MyViewData = {
  data: {
    adminWorkflows: { workflowId: string }[];
    savedViews: { name: string }[];
    pendingApprovals: {
      items: { requestId: string }[];
      totalQualifying: number;
    };
  };
};

describe("GET /dashboard/my-view — adminWorkflows (R10)", () => {
  it("createdBy-admin sees the workflow they created", async () => {
    const res = await makeApp(TENANT_A, USER_A_ADMIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.adminWorkflows.map((w) => w.workflowId)).toContain(workflowAId);
  });

  it("assignedTo-admin (not creator) also sees the workflow", async () => {
    const res = await makeApp(TENANT_A, USER_A_ASSIGNED_ADMIN).request(
      "/my-view",
    );
    const { data } = (await res.json()) as MyViewData;
    expect(data.adminWorkflows.map((w) => w.workflowId)).toContain(workflowAId);
  });

  it("a plain (non-admin) user in the same tenant sees no admin workflows", async () => {
    const res = await makeApp(TENANT_A, USER_A_PLAIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.adminWorkflows).toEqual([]);
  });

  it("Tenant B's admin never sees Tenant A's workflow, even by the same role", async () => {
    const res = await makeApp(TENANT_B, USER_B_ADMIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.adminWorkflows.map((w) => w.workflowId)).not.toContain(
      workflowAId,
    );
    expect(data.adminWorkflows.map((w) => w.workflowId)).toContain(workflowBId);
  });
});

describe("GET /dashboard/my-view — savedViews (R11)", () => {
  it("user sees their own saved view", async () => {
    const res = await makeApp(TENANT_A, USER_A_PLAIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.savedViews.map((v) => v.name)).toContain("V11 My Saved View");
  });

  it("user does not see another user's saved view in the same tenant", async () => {
    const res = await makeApp(TENANT_A, USER_A_PLAIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.savedViews.map((v) => v.name)).not.toContain(
      "Other User's Saved View",
    );
  });

  it("Tenant B's user sees no saved views from Tenant A", async () => {
    const res = await makeApp(TENANT_B, USER_B_ADMIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.savedViews).toEqual([]);
  });
});

describe("GET /dashboard/my-view — pendingApprovals (R12)", () => {
  it("the workflow's admin sees the pending access request", async () => {
    const res = await makeApp(TENANT_A, USER_A_ADMIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.pendingApprovals.items.map((i) => i.requestId)).toContain(
      requestOnAId,
    );
    expect(data.pendingApprovals.totalQualifying).toBeGreaterThanOrEqual(1);
  });

  it("a non-admin user in the same tenant never sees the pending request", async () => {
    const res = await makeApp(TENANT_A, USER_A_PLAIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.pendingApprovals.items).toEqual([]);
  });

  it("Tenant B's admin never sees Tenant A's pending request", async () => {
    const res = await makeApp(TENANT_B, USER_B_ADMIN).request("/my-view");
    const { data } = (await res.json()) as MyViewData;
    expect(data.pendingApprovals.items.map((i) => i.requestId)).not.toContain(
      requestOnAId,
    );
  });
});
