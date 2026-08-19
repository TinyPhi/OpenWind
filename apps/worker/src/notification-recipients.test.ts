import { describe, it, expect, vi, beforeEach } from "vitest";

let workflowRow: {
  createdBy: string | null;
  assignedTo: string[] | null;
} | null = null;
let tenantUserRow: { userId: string } | null = null;
let entityInstanceRow: {
  createdBy: string | null;
  assignedTo: string | null;
  fields?: Record<string, unknown>;
} | null = null;
let accessRequestRow: { requesterId: string } | null = null;

const mockLimit = vi.fn(() => {
  // Distinguish which table is being queried by inspecting the last `from`
  // call recorded below.
  if (currentFrom === "workflows")
    return Promise.resolve(workflowRow ? [workflowRow] : []);
  if (currentFrom === "entity_instances")
    return Promise.resolve(entityInstanceRow ? [entityInstanceRow] : []);
  if (currentFrom === "access_requests")
    return Promise.resolve(accessRequestRow ? [accessRequestRow] : []);
  return Promise.resolve(tenantUserRow ? [tenantUserRow] : []);
});
let currentFrom: string | null = null;
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn((table: unknown) => {
  currentFrom = table as string;
  return { where: mockWhere };
});
const mockSelect = vi.fn(() => ({ from: mockFrom }));

const mockTx = { select: mockSelect };

vi.mock("@platform/db", () => ({
  db: { select: mockSelect },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  workflows: "workflows",
  tenantUsers: "tenant_users",
  entityInstances: "entity_instances",
  accessRequests: "access_requests",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
}));

let systemAdminUserId: string | undefined;
vi.mock("@platform/config", () => ({
  get env() {
    return { SYSTEM_ADMIN_USER_ID: systemAdminUserId };
  },
}));

const { resolveRecipients } = await import("./notification-recipients.js");

describe("resolveRecipients", () => {
  beforeEach(() => {
    workflowRow = null;
    tenantUserRow = null;
    entityInstanceRow = null;
    accessRequestRow = null;
    systemAdminUserId = undefined;
  });

  it("entity.assigned: recipient is the assignee, self-suppressed if they're also the actor", async () => {
    const result = await resolveRecipients("t-1", "entity.assigned", {
      assigneeId: "u-assignee",
      assignedBy: "u-actor",
    });
    expect(result.recipients).toEqual(["u-assignee"]);

    const selfAssign = await resolveRecipients("t-1", "entity.assigned", {
      assigneeId: "u-actor",
      assignedBy: "u-actor",
    });
    expect(selfAssign.recipients).toEqual([]);
  });

  it("entity.unassigned: recipient is the previous assignee, self-suppressed if they reassigned it themselves", async () => {
    const result = await resolveRecipients("t-1", "entity.unassigned", {
      previousAssigneeId: "u-old-assignee",
      actorId: "u-reassigner",
    });
    expect(result.recipients).toEqual(["u-old-assignee"]);

    const selfReassigned = await resolveRecipients("t-1", "entity.unassigned", {
      previousAssigneeId: "u-old-assignee",
      actorId: "u-old-assignee",
    });
    expect(selfReassigned.recipients).toEqual([]);
  });

  it("comment.mentioned: only explicitly mentioned users, actor excluded even if self-mentioned", async () => {
    const result = await resolveRecipients("t-1", "comment.mentioned", {
      actorId: "u-author",
      mentionedUserIds: ["u-a", "u-b", "u-author"],
    });
    expect(result.recipients.sort()).toEqual(["u-a", "u-b"]);
  });

  it("comment.mention_access_granted: only the newly-granted mentioned users", async () => {
    const result = await resolveRecipients(
      "t-1",
      "comment.mention_access_granted",
      { actorId: "u-author", mentionedUserIds: ["u-a", "u-author"] },
    );
    expect(result.recipients).toEqual(["u-a"]);
  });

  it("comment.replied: the parent comment's author only, self-suppressed if replying to your own comment", async () => {
    const result = await resolveRecipients("t-1", "comment.replied", {
      actorId: "u-replier",
      targetUserId: "u-parent-author",
    });
    expect(result.recipients).toEqual(["u-parent-author"]);

    const selfReply = await resolveRecipients("t-1", "comment.replied", {
      actorId: "u-same",
      targetUserId: "u-same",
    });
    expect(selfReply.recipients).toEqual([]);
  });

  it("access.granted / access.revoked: the target user only", async () => {
    const granted = await resolveRecipients("t-1", "access.granted", {
      actorId: "u-admin",
      targetUserId: "u-target",
    });
    expect(granted.recipients).toEqual(["u-target"]);

    const revoked = await resolveRecipients("t-1", "access.revoked", {
      actorId: "u-admin",
      targetUserId: "u-target",
    });
    expect(revoked.recipients).toEqual(["u-target"]);
  });

  it("access.updated (level change, §2.3): the target user only", async () => {
    const result = await resolveRecipients("t-1", "access.updated", {
      actorId: "u-admin",
      targetUserId: "u-target",
    });
    expect(result.recipients).toEqual(["u-target"]);

    const selfUpdate = await resolveRecipients("t-1", "access.updated", {
      actorId: "u-target",
      targetUserId: "u-target",
    });
    expect(selfUpdate.recipients).toEqual([]);
  });

  it("access_request.created: the ticket's creator and assignee, self-suppressed if the requester is one of them", async () => {
    entityInstanceRow = { createdBy: "u-owner", assignedTo: "u-assignee" };
    const result = await resolveRecipients("t-1", "access_request.created", {
      actorId: "u-requester",
      instanceId: "e-1",
    });
    expect(result.recipients.sort()).toEqual(["u-assignee", "u-owner"]);

    const selfOwned = await resolveRecipients("t-1", "access_request.created", {
      actorId: "u-owner",
      instanceId: "e-1",
    });
    expect(selfOwned.recipients).toEqual(["u-assignee"]);
  });

  it("access_request.created: not the wider __accessUsers ACL, only creator/assignee", async () => {
    entityInstanceRow = { createdBy: "u-owner", assignedTo: null };
    const result = await resolveRecipients("t-1", "access_request.created", {
      actorId: "u-requester",
      instanceId: "e-1",
    });
    expect(result.recipients).toEqual(["u-owner"]);
  });

  it("access_request.created: no recipients if the entity can't be found", async () => {
    entityInstanceRow = null;
    const result = await resolveRecipients("t-1", "access_request.created", {
      actorId: "u-requester",
      instanceId: "e-missing",
    });
    expect(result.recipients).toEqual([]);
  });

  it("access_request.updated: the original requester only, self-suppressed if they resolved their own request", async () => {
    accessRequestRow = { requesterId: "u-requester" };
    const result = await resolveRecipients("t-1", "access_request.updated", {
      actorId: "u-admin",
      instanceId: "e-1",
      requestId: "req-1",
      status: "approved",
    });
    expect(result.recipients).toEqual(["u-requester"]);
    expect(result.reason).toBe("approved");

    const selfResolved = await resolveRecipients(
      "t-1",
      "access_request.updated",
      {
        actorId: "u-requester",
        instanceId: "e-1",
        requestId: "req-1",
        status: "rejected",
      },
    );
    expect(selfResolved.recipients).toEqual([]);
  });

  it("access_request.updated: no recipients if the request can't be found", async () => {
    accessRequestRow = null;
    const result = await resolveRecipients("t-1", "access_request.updated", {
      actorId: "u-admin",
      instanceId: "e-1",
      requestId: "req-missing",
      status: "approved",
    });
    expect(result.recipients).toEqual([]);
  });

  it("workflow.transitioned: the ticket's creator and assignee, self-suppressed if the actor is one of them (§2.4)", async () => {
    entityInstanceRow = { createdBy: "u-owner", assignedTo: "u-assignee" };
    const result = await resolveRecipients("t-1", "workflow.transitioned", {
      actorId: "u-agent",
      instanceId: "e-1",
      fromState: "open",
      toState: "done",
    });
    expect(result.recipients.sort()).toEqual(["u-assignee", "u-owner"]);
    expect(result.reason).toBe("done");

    const selfTransitioned = await resolveRecipients(
      "t-1",
      "workflow.transitioned",
      {
        actorId: "u-owner",
        instanceId: "e-1",
        toState: "done",
      },
    );
    expect(selfTransitioned.recipients).toEqual(["u-assignee"]);
  });

  it("workflow.transitioned: no recipients if the entity can't be found", async () => {
    entityInstanceRow = null;
    const result = await resolveRecipients("t-1", "workflow.transitioned", {
      actorId: "u-agent",
      instanceId: "e-missing",
      toState: "done",
    });
    expect(result.recipients).toEqual([]);
  });

  it("entity.due_date_approaching: the FULL access list (creator + assignedTo + every __accessUsers entry), §2.8", async () => {
    entityInstanceRow = {
      createdBy: "u-owner",
      assignedTo: "u-assignee",
      fields: {
        __accessUsers: { "u-viewer-1": { level: "read_only" }, "u-owner": {} },
      },
    };
    const result = await resolveRecipients(
      "t-1",
      "entity.due_date_approaching",
      { instanceId: "e-1" },
    );
    expect(result.recipients.sort()).toEqual(
      ["u-assignee", "u-owner", "u-viewer-1"].sort(),
    );
    expect(result.actorId).toBeNull();
  });

  it("entity.due_date_approaching: no recipients if the entity can't be found", async () => {
    entityInstanceRow = null;
    const result = await resolveRecipients(
      "t-1",
      "entity.due_date_approaching",
      { instanceId: "e-missing" },
    );
    expect(result.recipients).toEqual([]);
  });

  it("workflow.sla_breached: all current workflow admins (createdBy + assignedTo, deduped)", async () => {
    workflowRow = { createdBy: "u-owner", assignedTo: ["u-admin1", "u-owner"] };
    const result = await resolveRecipients("t-1", "workflow.sla_breached", {
      workflowId: "wf-1",
    });
    expect(result.recipients.sort()).toEqual(["u-admin1", "u-owner"]);
  });

  it("workflow.sla_breached: no recipients if the workflow can't be found", async () => {
    workflowRow = null;
    const result = await resolveRecipients("t-1", "workflow.sla_breached", {
      workflowId: "wf-missing",
    });
    expect(result.recipients).toEqual([]);
  });

  it("system.error: no recipients when SYSTEM_ADMIN_USER_ID is unset", async () => {
    systemAdminUserId = undefined;
    const result = await resolveRecipients("t-1", "system.error", {
      reason: "boom",
    });
    expect(result.recipients).toEqual([]);
  });

  it("system.error: no recipients when the configured admin isn't a member of this tenant", async () => {
    systemAdminUserId = "u-admin";
    tenantUserRow = null;
    const result = await resolveRecipients("t-1", "system.error", {
      reason: "boom",
    });
    expect(result.recipients).toEqual([]);
  });

  it("system.error: notifies the configured admin when they're a tenant member", async () => {
    systemAdminUserId = "u-admin";
    tenantUserRow = { userId: "u-admin" };
    const result = await resolveRecipients("t-1", "system.error", {
      reason: "boom",
    });
    expect(result.recipients).toEqual(["u-admin"]);
    expect(result.reason).toBe("boom");
  });

  describe("malformed payload parsing failure path", () => {
    const eventTypes = [
      "entity.assigned",
      "entity.unassigned",
      "comment.mentioned",
      "comment.mention_access_granted",
      "comment.replied",
      "access.granted",
      "access.revoked",
      "access.updated",
      "access_request.created",
      "access_request.updated",
      "workflow.transitioned",
      "entity.due_date_approaching",
      "workflow.sla_breached",
      "system.error",
    ];

    it.each(eventTypes)(
      "gracefully handles parsing failure for %s",
      async (eventType) => {
        const result = await resolveRecipients("t-1", eventType, {
          invalidKey: "invalidValue",
        });
        expect(result.recipients).toEqual([]);
        expect(result.actorId).toBeNull();
      },
    );
  });
});
