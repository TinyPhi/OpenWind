import { describe, it, expect, vi, beforeEach } from "vitest";

let instanceRow: { typeName: string } | null = { typeName: "Support Ticket" };

const mockLimit = vi.fn(() =>
  Promise.resolve(instanceRow ? [instanceRow] : []),
);
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockInnerJoin = vi.fn(() => ({ where: mockWhere }));
const mockFrom = vi.fn(() => ({ innerJoin: mockInnerJoin }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

const mockTx = { select: mockSelect };

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  entityInstances: "entity_instances",
  entityTypes: "entity_types",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
}));

const { buildRecordLink, buildNotificationContent } =
  await import("./notification-templates.js");

describe("buildRecordLink", () => {
  beforeEach(() => {
    instanceRow = { typeName: "Support Ticket" };
  });

  it("slugifies the entity type name the same way admin-ui's toTypeSlug does", async () => {
    const link = await buildRecordLink("t-1", "inst-1");
    expect(link).toBe("/records/support-ticket/inst-1");
  });

  it("returns null when the instance can't be found", async () => {
    instanceRow = null;
    const link = await buildRecordLink("t-1", "inst-missing");
    expect(link).toBeNull();
  });
});

describe("buildNotificationContent", () => {
  beforeEach(() => {
    instanceRow = { typeName: "Support Ticket" };
  });

  it("never interpolates raw free-text into the mention notification body", async () => {
    const content = await buildNotificationContent("comment.mentioned", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: undefined,
    });
    expect(content.title).toBe("Comment mention");
    expect(content.body).toBe("Jane Doe mentioned you in a comment");
    expect(content.link).toBe("/records/support-ticket/inst-1");
  });

  it("entity.unassigned has a distinct message from entity.assigned", async () => {
    const content = await buildNotificationContent("entity.unassigned", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: undefined,
    });
    expect(content.title).toBe("Assignment updated");
    expect(content.body).toBe(
      "Jane Doe reassigned a record you were assigned to",
    );
    expect(content.link).toBe("/records/support-ticket/inst-1");
  });

  it("comment.mention_access_granted has a distinct message from a plain mention", async () => {
    const content = await buildNotificationContent(
      "comment.mention_access_granted",
      {
        tenantId: "t-1",
        instanceId: "inst-1",
        actorName: "Jane Doe",
        reason: undefined,
      },
    );
    expect(content.title).toBe("Access granted via mention");
    expect(content.body).toBe(
      "Jane Doe granted you access to this ticket via a comment mention",
    );
  });

  it("comment.replied notifies the parent comment's author, distinct from a mention", async () => {
    const content = await buildNotificationContent("comment.replied", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: undefined,
    });
    expect(content.title).toBe("New reply");
    expect(content.body).toBe("Jane Doe replied to your comment");
    expect(content.link).toBe("/records/support-ticket/inst-1");
  });

  it("access.updated (level change) has a distinct message from grant/revoke", async () => {
    const content = await buildNotificationContent("access.updated", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: undefined,
    });
    expect(content.title).toBe("Access level changed");
    expect(content.body).toBe("Jane Doe changed your access level on a ticket");
  });

  it("workflow.transitioned (§2.4) mentions the destination state when given a reason, falls back generically otherwise", async () => {
    const withState = await buildNotificationContent("workflow.transitioned", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: "done",
    });
    expect(withState.title).toBe("Ticket status changed");
    expect(withState.body).toBe('Jane Doe moved a ticket to "done"');

    const noState = await buildNotificationContent("workflow.transitioned", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "System",
      reason: undefined,
    });
    expect(noState.body).toBe("System updated a ticket's status");
  });

  it("access_request.created notifies the ticket owner that access was requested", async () => {
    const content = await buildNotificationContent("access_request.created", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: undefined,
    });
    expect(content.title).toBe("Access requested");
    expect(content.body).toBe("Jane Doe requested access to a ticket");
    expect(content.link).toBe("/records/support-ticket/inst-1");
  });

  it("access_request.updated tells the requester the outcome, distinct wording for approved vs rejected", async () => {
    const approved = await buildNotificationContent("access_request.updated", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: "approved",
    });
    expect(approved.title).toBe("Access request approved");
    expect(approved.body).toBe("Your access request was approved");

    const rejected = await buildNotificationContent("access_request.updated", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "Jane Doe",
      reason: "rejected",
    });
    expect(rejected.title).toBe("Access request denied");
    expect(rejected.body).toBe("Your access request was denied");
  });

  it("entity.due_date_approaching (§2.8) has its own title/body", async () => {
    const content = await buildNotificationContent(
      "entity.due_date_approaching",
      {
        tenantId: "t-1",
        instanceId: "inst-1",
        actorName: "System",
        reason: undefined,
      },
    );
    expect(content.title).toBe("Due date approaching");
    expect(content.body).toBe("A ticket's due date is coming up in 2 days");
    expect(content.link).toBe("/records/support-ticket/inst-1");
  });

  it("system.error always links to the system-logs page, not an entity", async () => {
    const content = await buildNotificationContent("system.error", {
      tenantId: "t-1",
      instanceId: undefined,
      actorName: "System",
      reason: "Outbound handoff failed after 3 attempts",
    });
    expect(content.link).toBe("/admin/system-logs");
    expect(content.body).toBe("Outbound handoff failed after 3 attempts");
  });

  it("keeps plain HTML entity characters (like O'Brien and Smith & Sons) as plain text while stripping HTML tag characters", async () => {
    const content = await buildNotificationContent("comment.mentioned", {
      tenantId: "t-1",
      instanceId: "inst-1",
      actorName: "O'Brien <script>alert(1)</script>",
      reason: undefined,
    });
    expect(content.body).toBe(
      "O'Brien scriptalert(1)/script mentioned you in a comment",
    );

    const errorContent = await buildNotificationContent("system.error", {
      tenantId: "t-1",
      instanceId: undefined,
      actorName: "System",
      reason: "Failed: <img src=x onerror=alert(2)> error & warning",
    });
    expect(errorContent.body).toBe(
      "Failed: img src=x onerror=alert(2) error & warning",
    );
  });

  it("throws for an unrecognized event type rather than writing a blank notification", async () => {
    await expect(
      buildNotificationContent("unknown.event", {
        tenantId: "t-1",
        instanceId: undefined,
        actorName: "System",
        reason: undefined,
      }),
    ).rejects.toThrow();
  });
});
