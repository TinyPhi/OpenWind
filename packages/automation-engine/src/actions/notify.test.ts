import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerEvent } from "../event-schemas.js";

const insertedRows: Array<{ table: unknown; values: unknown }> = [];

const dbMock = {
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      insertedRows.push({ table, values });
      return Promise.resolve(undefined);
    },
  }),
};

vi.mock("@platform/db", () => ({
  notifications: "notifications_table",
  notificationRecipients: "notification_recipients_table",
}));

const mockLoggerWarn = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("bullmq", () => ({
  Queue: class {
    add(...args: unknown[]) {
      return mockQueueAdd(...args);
    }
  },
}));

const { executeNotifyAction } = await import("./notify.js");

const EVENT = {} as TriggerEvent;

describe("executeNotifyAction", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    mockQueueAdd.mockClear();
  });

  it("skips and warns when no recipientId is configured", async () => {
    await executeNotifyAction(dbMock as never, "t-1", EVENT, {
      channel: ["email"],
    } as never);
    expect(insertedRows).toHaveLength(0);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("writes a notification + recipient row using the rule's own config content", async () => {
    await executeNotifyAction(dbMock as never, "t-1", EVENT, {
      recipientId: "u-target",
      payload: { title: "Custom title", body: "Custom body", link: "/x" },
    } as never);

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]?.table).toBe("notifications_table");
    expect(insertedRows[0]?.values).toMatchObject({
      tenantId: "t-1",
      type: "automation.notify",
      title: "Custom title",
      body: "Custom body",
      link: "/x",
    });
    expect(insertedRows[1]?.table).toBe("notification_recipients_table");
    expect(insertedRows[1]?.values).toMatchObject({
      tenantId: "t-1",
      userId: "u-target",
    });
  });

  it("falls back to generic title/body when the rule config doesn't provide them", async () => {
    await executeNotifyAction(dbMock as never, "t-1", EVENT, {
      recipientId: "u-target",
    } as never);

    expect(insertedRows[0]?.values).toMatchObject({
      title: "Notification",
      body: "You have a new notification",
      link: null,
    });
  });

  it("enqueues the outbound handoff job when a redis connection is provided", async () => {
    await executeNotifyAction(
      dbMock as never,
      "t-1",
      EVENT,
      { recipientId: "u-target" } as never,
      {} as never,
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "dispatch",
      expect.objectContaining({ tenantId: "t-1" }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it("does not enqueue an outbound job when no redis connection is provided", async () => {
    await executeNotifyAction(dbMock as never, "t-1", EVENT, {
      recipientId: "u-target",
    } as never);

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
