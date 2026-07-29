import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

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

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    getWorkflow: vi.fn(),
    isWorkflowAdmin: vi.fn(() => false),
  };
});

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
const outboxEventsTable = { id: "outbox_events.id" };
const workflowEventsTable = { id: "workflow_events.id" };

let currentFromTable: unknown;
let currentWhereFileId: string | undefined;
let currentInsertTable: unknown;
const outboxInserts: Array<{ eventType: string; payload: unknown }> = [];
let parentCommentActorId: string | null = null;

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
    if (currentFromTable === workflowEventsTable) {
      return Promise.resolve(
        parentCommentActorId ? [{ actorId: parentCommentActorId }] : [],
      );
    }
    return Promise.resolve(instanceRow ? [instanceRow] : []);
  },
  insert: (table: unknown) => {
    currentInsertTable = table;
    return mockTx;
  },
  values: (arg: unknown) => {
    if (currentInsertTable === outboxEventsTable) {
      const payload = arg as { eventType: string };
      outboxInserts.push({ eventType: payload.eventType, payload });
    }
    return mockTx;
  },
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
  workflowEvents: workflowEventsTable,
  entityInstances: entityInstancesTable,
  entityRelations: {},
  tenantUsers: {},
  files: filesTable,
  outboxEvents: outboxEventsTable,
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { addCommentHandler } = await import("./add-comment.js");
const { getWorkflow } = await import("@platform/workflow-engine");

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
    currentInsertTable = undefined;
    outboxInserts.length = 0;
    parentCommentActorId = null;
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

  it("does not grant access to a mentioned user when the commenter is unprivileged and not the owner", async () => {
    instanceRow!.assignedTo = "someone-else";
    instanceRow!.createdBy = "someone-else";
    instanceRow!.fields = {
      __accessUsers: { "u-bbb": { level: "read_comment" } },
    };

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_comment" }],
      }),
    });

    expect(res.status).toBe(201);
    // Commenter already has an ACL entry (no self-grant), and lacks grant
    // authority (not admin/agent, not creator/assignee) — the mentioned
    // OTHER_USER_ID must never receive an access grant here.
    expect(grantedUpdates.length).toBe(0);
  });

  it("allows the creator/assignee (owner), even without admin/agent role, to grant access to a mentioned user — mirrors revoke-access.ts's authority", async () => {
    // Default beforeEach instanceRow already has u-bbb as both assignedTo and
    // createdBy, and currentAuth is role "user" (not admin/agent) — this is
    // exactly the owner-without-global-role scenario revoke-access.ts allows.
    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_only" }],
      }),
    });

    expect(res.status).toBe(201);
    const eventTypes = outboxInserts.map((o) => o.eventType);
    expect(eventTypes).toContain("comment.mention_access_granted");
    expect(eventTypes).not.toContain("comment.mentioned");
    expect(grantedUpdates.length).toBe(1); // grant for the mentioned user (commenter is already assignee, no self-grant)
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

  it("mentioning a user with no prior access fires comment.mention_access_granted, not comment.mentioned", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    instanceRow!.assignedTo = "someone-else";
    instanceRow!.fields = {}; // OTHER_USER_ID has no existing access

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_comment" }],
      }),
    });

    expect(res.status).toBe(201);
    const eventTypes = outboxInserts.map((o) => o.eventType);
    expect(eventTypes).toContain("comment.mention_access_granted");
    expect(eventTypes).not.toContain("comment.mentioned");
    const grantEvent = outboxInserts.find(
      (o) => o.eventType === "comment.mention_access_granted",
    );
    const grantPayload = grantEvent?.payload as {
      payload: { mentionedUserIds: string[] };
    };
    expect(grantPayload.payload.mentionedUserIds).toEqual([OTHER_USER_ID]);
  });

  it("mentioning a user who already has access fires comment.mentioned, not comment.mention_access_granted", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    instanceRow!.assignedTo = "someone-else";
    instanceRow!.fields = {
      __accessUsers: { [OTHER_USER_ID]: { level: "read_comment" } },
    };

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_comment" }],
      }),
    });

    expect(res.status).toBe(201);
    const eventTypes = outboxInserts.map((o) => o.eventType);
    expect(eventTypes).toContain("comment.mentioned");
    expect(eventTypes).not.toContain("comment.mention_access_granted");
  });

  it("mentioning a user with no prior access as an unprivileged, non-owner commenter fires comment.mentioned (no access is actually granted)", async () => {
    instanceRow!.assignedTo = "someone-else";
    instanceRow!.createdBy = "someone-else";
    instanceRow!.fields = {
      __accessUsers: { "u-bbb": { level: "read_comment" } },
    }; // commenter has plain access, not owner; OTHER_USER_ID has no existing access

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "cc @someone",
        mentions: [{ userId: OTHER_USER_ID, level: "read_comment" }],
      }),
    });

    expect(res.status).toBe(201);
    const eventTypes = outboxInserts.map((o) => o.eventType);
    expect(eventTypes).toContain("comment.mentioned");
    expect(eventTypes).not.toContain("comment.mention_access_granted");
  });

  it("replying to a comment fires comment.replied targeting the parent comment's author", async () => {
    parentCommentActorId = "u-parent-author";

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "replying",
        replyTo: "00000000-0000-0000-0000-0000000000aa",
      }),
    });

    expect(res.status).toBe(201);
    const replyEvent = outboxInserts.find(
      (o) => o.eventType === "comment.replied",
    );
    expect(replyEvent).toBeDefined();
    const replyPayload = replyEvent?.payload as {
      payload: { targetUserId: string };
    };
    expect(replyPayload.payload.targetUserId).toBe("u-parent-author");
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
    currentInsertTable = undefined;
    outboxInserts.length = 0;
    parentCommentActorId = null;
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

describe("POST /entities/:id/comments — workflow lookup errors (#184)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedUpdates.length = 0;
    fileRows = {};
    fileBindUpdates.length = 0;
    currentFromTable = undefined;
    currentWhereFileId = undefined;
    // Not the assignee/creator and no accessUsers entry, so canComment falls
    // through to the getWorkflow-based workflow-admin check.
    instanceRow = {
      id: INST_ID,
      workflowId: "wf-deleted",
      currentState: "open",
      assignedTo: "someone-else",
      createdBy: "someone-else",
      fields: {},
    };
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "test@example.com",
    };
  });

  it("returns 404, not 500, when the record's workflow was deleted before the workflow-admin check", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    vi.mocked(getWorkflow).mockRejectedValue(
      new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId: "wf-deleted" }),
    );

    const res = await makeApp().request(`/${INST_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "just a comment" }),
    });

    expect(res.status).toBe(404);
  });
});
