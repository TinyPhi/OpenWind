import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Strategy: real drizzle-orm operators (no-op mocked) since add-comment.ts
// builds several distinct queries (instance lookup, tenant_users lookup,
// workflow_events insert, entity_instances access-grant update). The mock tx
// resolves each `.limit(1)`/`.returning()` call in call order rather than
// inspecting the (mocked) query object.

vi.mock("drizzle-orm", () => {
  const noop = vi.fn(() => "sql");
  const sqlFn = Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => "sql",
    { join: vi.fn(() => "sql") },
  );
  return { eq: noop, and: noop, isNull: noop, sql: sqlFn };
});

let currentAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["user"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", currentAuth);
      await next();
    },
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: vi.fn().mockResolvedValue([]),
}));

let instanceRow: {
  id: string;
  workflowId: string | null;
  currentState: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  fields: Record<string, unknown>;
} | null = null;

const mockUpdateSet = vi
  .fn()
  .mockReturnValue({ where: () => Promise.resolve(undefined) });
const grantedUpdates: unknown[] = [];

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  // Instance lookup is the only `.limit(1)` call reached in these tests
  // (tenantUsers lookup is skipped since dbUser resolution isn't exercised).
  limit: () => Promise.resolve(instanceRow ? [instanceRow] : []),
  insert: () => mockTx,
  values: () => mockTx,
  returning: () =>
    Promise.resolve([{ id: "evt-1", metadata: { type: "comment" } }]),
  update: () => ({
    set: (arg: unknown) => {
      grantedUpdates.push(arg);
      return mockUpdateSet(arg);
    },
  }),
};

vi.mock("@platform/db", () => ({
  workflowEvents: {},
  entityInstances: {
    id: "entity_instances.id",
    tenantId: "entity_instances.tenant_id",
  },
  entityRelations: {},
  tenantUsers: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { addCommentHandler } = await import("./add-comment.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/comments", ...addCommentHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_USER_ID = "00000000-0000-0000-0000-00000000dead";

describe("POST /entities/:id/comments — mention access grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedUpdates.length = 0;
    instanceRow = {
      id: INST_ID,
      workflowId: "wf-1",
      currentState: "open",
      assignedTo: "u-bbb",
      createdBy: "u-bbb",
      fields: {},
    };
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "test@example.com",
    };
  });

  it("does not grant access to a mentioned user when the commenter is unprivileged", async () => {
    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_comment" }],
      }),
    });

    expect(res.status).toBe(201);
    const grantedUserIds = grantedUpdates.length; // one update per grant.userId call
    // Only the commenter's own self-grant (if not already assignee) may run;
    // the mentioned OTHER_USER_ID must never receive an access grant here.
    expect(grantedUserIds).toBe(0); // commenter is already assignedTo, no self-grant needed either
  });

  it("allows an admin/agent commenter to grant access to a mentioned user", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    instanceRow!.assignedTo = "someone-else";

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_comment" }],
      }),
    });

    expect(res.status).toBe(201);
    // One grant for the admin commenter (not assignee) + one for the mention.
    expect(grantedUpdates.length).toBe(2);
  });
});
