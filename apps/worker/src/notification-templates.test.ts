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
