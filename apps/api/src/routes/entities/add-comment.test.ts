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

// fileId -> row, so tests can stub what the files-table lookup returns per id.
let fileRows: Record<
  string,
  {
    id: string;
    tenantId: string;
    entityId: string | null;
    scanStatus: string;
  }
> = {};
const fileBindUpdates: Array<{ fileId: string; entityId: string }> = [];

const mockUpdateSet = vi
  .fn()
  .mockReturnValue({ where: () => Promise.resolve(undefined) });
const grantedUpdates: unknown[] = [];

const entityInstancesTable = {
  id: "entity_instances.id",
  tenantId: "entity_instances.tenant_id",
};
const filesTable = { id: "files.id", tenantId: "files.tenant_id" };

let currentFromTable: unknown;
let currentWhereFileId: string | undefined;

const mockTx = {
  select: () => mockTx,
  from: (table: unknown) => {
    currentFromTable = table;
    return mockTx;
  },
  // Real `eq`/`and` are no-op mocked to the string "sql" (see drizzle-orm
  // mock above), so the fileId being queried can't be read off the where
  // clause — tests instead set `currentWhereFileId` directly before making
  // the request, matching the one fileId under test.
  where: () => mockTx,
  limit: () => {
    if (currentFromTable === filesTable) {
      const row = currentWhereFileId ? fileRows[currentWhereFileId] : undefined;
      return Promise.resolve(row ? [row] : []);
    }
    return Promise.resolve(instanceRow ? [instanceRow] : []);
  },
  insert: () => mockTx,
  values: () => mockTx,
  returning: () =>
    Promise.resolve([{ id: "evt-1", metadata: { type: "comment" } }]),
  update: (table: unknown) => ({
    set: (arg: unknown) => {
      if (table === filesTable && currentWhereFileId) {
        fileBindUpdates.push({
          fileId: currentWhereFileId,
          entityId: (arg as { entityId: string }).entityId,
        });
        return { where: () => Promise.resolve(undefined) };
      }
      grantedUpdates.push(arg);
      return mockUpdateSet(arg);
    },
  }),
};

vi.mock("@platform/db", () => ({
  workflowEvents: {},
  entityInstances: entityInstancesTable,
  entityRelations: {},
  tenantUsers: {},
  files: filesTable,
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
    fileRows = {};
    fileBindUpdates.length = 0;
    currentFromTable = undefined;
    currentWhereFileId = undefined;
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

  it("does not downgrade a commenter's existing read_write ACL entry to read_comment", async () => {
    instanceRow!.assignedTo = "someone-else"; // commenter is not the assignee...
    instanceRow!.fields = {
      __accessUsers: { "u-bbb": { level: "read_write", tag: "manual" } },
    }; // ...but already has an explicit read_write grant

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "just a comment" }),
    });

    expect(res.status).toBe(201);
    // No grant write at all — the existing read_write entry must be left untouched.
    expect(grantedUpdates.length).toBe(0);
  });

  it("still grants read_comment to a commenter with no existing ACL entry", async () => {
    instanceRow!.assignedTo = "someone-else";
    instanceRow!.fields = {};

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "just a comment" }),
    });

    expect(res.status).toBe(201);
    expect(grantedUpdates.length).toBe(1);
  });
});

describe("POST /entities/:id/comments — fileIds binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedUpdates.length = 0;
    fileRows = {};
    fileBindUpdates.length = 0;
    currentFromTable = undefined;
    currentWhereFileId = undefined;
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

  const FILE_ID = "00000000-0000-0000-0000-0000000000f1";

  it("binds an unbound, clean file to this entity before accepting the comment", async () => {
    fileRows[FILE_ID] = {
      id: FILE_ID,
      tenantId: "t-aaa",
      entityId: null,
      scanStatus: "clean",
    };
    currentWhereFileId = FILE_ID;

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "see attached", fileIds: [FILE_ID] }),
    });

    expect(res.status).toBe(201);
    expect(fileBindUpdates).toEqual([{ fileId: FILE_ID, entityId: INST_ID }]);
  });

  it("rejects a fileId that does not exist / belongs to another tenant", async () => {
    currentWhereFileId = FILE_ID; // fileRows has no entry — simulates not found

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "see attached", fileIds: [FILE_ID] }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a fileId already bound to a different entity", async () => {
    fileRows[FILE_ID] = {
      id: FILE_ID,
      tenantId: "t-aaa",
      entityId: "some-other-entity-id",
      scanStatus: "clean",
    };
    currentWhereFileId = FILE_ID;

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "see attached", fileIds: [FILE_ID] }),
    });

    expect(res.status).toBe(409);
    expect(fileBindUpdates).toEqual([]);
  });

  it("rejects a fileId that hasn't cleared antivirus scanning yet", async () => {
    fileRows[FILE_ID] = {
      id: FILE_ID,
      tenantId: "t-aaa",
      entityId: null,
      scanStatus: "pending",
    };
    currentWhereFileId = FILE_ID;

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "see attached", fileIds: [FILE_ID] }),
    });

    expect(res.status).toBe(422);
    expect(fileBindUpdates).toEqual([]);
  });
});
