/**
 * notification-worker.test.ts
 *
 * Covers the global outbound-notifications kill switch
 * (docs/specs/outbound-notifications-kill-switch.md): in-app delivery must
 * proceed regardless of the flag; only the outbound enqueue is gated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedProcessor:
  | ((job: {
      data: {
        outboxEventId: string;
        tenantId: string;
        eventType: string;
        version: number;
        payload: Record<string, unknown>;
      };
    }) => Promise<void>)
  | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor as typeof capturedProcessor;
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const mockNotifyOutboundQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("./queues.js", () => ({
  connection: {},
  notifyOutboundQueue: {
    add: (...args: unknown[]) => mockNotifyOutboundQueueAdd(...args),
  },
}));

const mockInsertValues = vi.fn().mockReturnValue({
  onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
});
const mockTx = {
  insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
};

let outboundEnabled = true;
vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  notifications: "notifications_table",
  notificationRecipients: "notification_recipients_table",
  tenantUsers: "tenant_users_table",
  deadLetterEvents: "dead_letter_events_table",
  isOutboundNotificationsEnabled: () => Promise.resolve(outboundEnabled),
  isTenantActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
}));

const mockRedisPublish = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/redis", () => ({
  getRedis: () => ({ publish: mockRedisPublish }),
  NOTIFICATION_PUSH_CHANNEL: "notifications:push",
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./notification-recipients.js", () => ({
  resolveRecipients: vi.fn().mockResolvedValue({
    recipients: ["u-1"],
    actorId: null,
    instanceId: "i-1",
    reason: "assigned",
  }),
}));

vi.mock("./notification-templates.js", () => ({
  buildNotificationContent: vi.fn().mockResolvedValue({
    title: "t",
    body: "b",
    link: null,
  }),
}));

await import("./notification-worker.js");

describe("notificationWorker processor", () => {
  beforeEach(() => {
    mockNotifyOutboundQueueAdd.mockClear();
    mockInsertValues.mockClear();
    outboundEnabled = true;
  });

  const job = {
    data: {
      outboxEventId: "evt-1",
      tenantId: "t-1",
      eventType: "entity.assigned",
      version: 1,
      payload: {},
    },
  };

  it("enqueues the outbound handoff when the kill switch is enabled", async () => {
    await capturedProcessor!(job);
    expect(mockNotifyOutboundQueueAdd).toHaveBeenCalledWith(
      "dispatch",
      expect.objectContaining({ tenantId: "t-1" }),
      expect.objectContaining({ jobId: "evt-1" }),
    );
    expect(mockInsertValues).toHaveBeenCalled();
  });

  it("skips the outbound enqueue when the kill switch is disabled, but still delivers in-app", async () => {
    outboundEnabled = false;
    await capturedProcessor!(job);
    expect(mockNotifyOutboundQueueAdd).not.toHaveBeenCalled();
    // in-app inserts (notification + recipients) still happen
    expect(mockInsertValues).toHaveBeenCalled();
  });
});
