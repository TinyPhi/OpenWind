import { describe, it, expect, vi, beforeEach } from "vitest";

let workflowRow: {
  createdBy: string | null;
  assignedTo: string[] | null;
} | null = null;
let tenantUserRow: { userId: string } | null = null;

const mockLimit = vi.fn(() => {
  // Distinguish which table is being queried by inspecting the last `from`
  // call recorded below.
  if (currentFrom === "workflows")
    return Promise.resolve(workflowRow ? [workflowRow] : []);
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
});
