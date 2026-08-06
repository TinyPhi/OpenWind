import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerEvent } from "../event-schemas.js";

const insertedRows: Array<{ table: unknown; values: unknown }> = [];

const dbMock = {
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      insertedRows.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  }),
};

let outboundEnabled = true;
vi.mock("@platform/db", () => ({
  notifications: "notifications_table",
  notificationRecipients: "notification_recipients_table",
  isOutboundNotificationsEnabled: () => Promise.resolve(outboundEnabled),
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

vi.mock("../ssrf-guard.js", () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue("1.2.3.4"),
}));

vi.mock("@platform/config", () => ({
  env: {
    APP_URL: "https://platform.example.com",
    SSRF_BLOCK_CIDRS: [],
  },
}));

const { executeNotifyAction } = await import("./notify.js");

const EVENT = {} as TriggerEvent;
const RULE_ID = "rule-aaa";
const EXEC_ID = "exec-bbb";

describe("executeNotifyAction", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    mockQueueAdd.mockClear();
    outboundEnabled = true;
  });

  it("skips and warns when no recipientId is configured", async () => {
    await executeNotifyAction(dbMock as never, "t-1", RULE_ID, EXEC_ID, EVENT, {
      channel: ["email"],
    } as never);
    expect(insertedRows).toHaveLength(0);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("writes a notification + recipient row using the rule's own config content", async () => {
    await executeNotifyAction(dbMock as never, "t-1", RULE_ID, EXEC_ID, EVENT, {
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

  it("derives a stable notificationId across retries when outboxEventId is provided (#228)", async () => {
    const OUTBOX_ID = "outbox-evt-stable-aaa";
    // Simulate first attempt: execId-1
    await executeNotifyAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      "exec-attempt-1",
      EVENT,
      { recipientId: "u-target" } as never,
      undefined,
      OUTBOX_ID,
    );
    const idFirst = (insertedRows[0]?.values as { id?: string })?.id;

    insertedRows.length = 0;
    // Simulate BullMQ retry: different execId, same outboxEventId → same notificationId
    await executeNotifyAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      "exec-attempt-2",
      EVENT,
      { recipientId: "u-target" } as never,
      undefined,
      OUTBOX_ID,
    );
    const idSecond = (insertedRows[0]?.values as { id?: string })?.id;

    expect(idFirst).toBe(idSecond);
    expect(idFirst).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to execId when no outboxEventId — same execId still stable", async () => {
    await executeNotifyAction(dbMock as never, "t-1", RULE_ID, EXEC_ID, EVENT, {
      recipientId: "u-target",
    } as never);
    const idFirst = (insertedRows[0]?.values as { id?: string })?.id;

    insertedRows.length = 0;
    await executeNotifyAction(dbMock as never, "t-1", RULE_ID, EXEC_ID, EVENT, {
      recipientId: "u-target",
    } as never);
    const idSecond = (insertedRows[0]?.values as { id?: string })?.id;

    expect(idFirst).toBe(idSecond);
    expect(idFirst).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("produces different ids for different outboxEventIds (different logical events)", async () => {
    await executeNotifyAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      EVENT,
      { recipientId: "u-target" } as never,
      undefined,
      "outbox-evt-aaa",
    );
    const idA = (insertedRows[0]?.values as { id?: string })?.id;

    insertedRows.length = 0;
    await executeNotifyAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      EVENT,
      { recipientId: "u-target" } as never,
      undefined,
      "outbox-evt-bbb",
    );
    const idB = (insertedRows[0]?.values as { id?: string })?.id;

    expect(idA).not.toBe(idB);
  });

  it("falls back to generic title/body when the rule config doesn't provide them", async () => {
    await executeNotifyAction(dbMock as never, "t-1", RULE_ID, EXEC_ID, EVENT, {
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
      RULE_ID,
      EXEC_ID,
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
    await executeNotifyAction(dbMock as never, "t-1", RULE_ID, EXEC_ID, EVENT, {
      recipientId: "u-target",
    } as never);

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does not enqueue an outbound job when the global kill switch is disabled, but still delivers in-app", async () => {
    outboundEnabled = false;
    await executeNotifyAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      EVENT,
      { recipientId: "u-target" } as never,
      {} as never,
    );

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(2);
  });

  describe("link validation", () => {
    it("allows relative links starting with /", async () => {
      const { validateNotifyLink } = await import("./notify.js");
      await expect(
        validateNotifyLink("/entities/abc"),
      ).resolves.toBeUndefined();
    });

    it("allows absolute links matching APP_URL's host or subdomain", async () => {
      const { validateNotifyLink } = await import("./notify.js");
      await expect(
        validateNotifyLink("https://platform.example.com/entities/abc"),
      ).resolves.toBeUndefined();
      await expect(
        validateNotifyLink("https://sub.platform.example.com/entities/abc"),
      ).resolves.toBeUndefined();
    });

    it("blocks absolute links to other domains", async () => {
      const { validateNotifyLink } = await import("./notify.js");
      await expect(
        validateNotifyLink("https://google.com/entities/abc"),
      ).rejects.toThrow();
    });

    it("blocks absolute links matching SSRF blocked ranges", async () => {
      const { validateNotifyLink } = await import("./notify.js");
      const { validateWebhookUrl } = await import("../ssrf-guard.js");
      vi.mocked(validateWebhookUrl).mockRejectedValueOnce(
        new Error("SSRF_BLOCKED"),
      );
      await expect(
        validateNotifyLink("https://platform.example.com/entities/abc"),
      ).rejects.toThrow();
    });
  });
});
