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
const workflowEventsTable = "workflow_events_table";
const accessRequestsTable = "access_requests_table";
let currentFromTable: unknown;
let commentRow: {
  metadata: unknown;
  actorId: string;
  createdAt: Date;
} | null = null;
let accessRequestRow: {
  requesterId: string;
  status: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
} | null = null;

const mockTx = {
  insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
  select: () => mockTx,
  from: (table: unknown) => {
    currentFromTable = table;
    return mockTx;
  },
  where: () => mockTx,
  limit: () => {
    if (currentFromTable === workflowEventsTable) {
      return Promise.resolve(commentRow ? [commentRow] : []);
    }
    if (currentFromTable === accessRequestsTable) {
      return Promise.resolve(accessRequestRow ? [accessRequestRow] : []);
    }
    return Promise.resolve([]);
  },
};

let outboundEnabled = true;
vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  notifications: "notifications_table",
  notificationRecipients: "notification_recipients_table",
  tenantUsers: "tenant_users_table",
  deadLetterEvents: "dead_letter_events_table",
  workflowEvents: workflowEventsTable,
  accessRequests: accessRequestsTable,
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
    mockRedisPublish.mockClear();
    outboundEnabled = true;
    currentFromTable = undefined;
    commentRow = null;
    accessRequestRow = null;
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

describe("notificationWorker processor — ticket-room live push (docs/specs/ticket-live-updates.md)", () => {
  beforeEach(() => {
    mockRedisPublish.mockClear();
    currentFromTable = undefined;
    commentRow = null;
    accessRequestRow = null;
  });

  it("publishes a room-kind push for comment.created, looking up the comment's body/author", async () => {
    commentRow = {
      metadata: { text: "hello world" },
      actorId: "u-author",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    await capturedProcessor!({
      data: {
        outboxEventId: "evt-2",
        tenantId: "t-1",
        eventType: "comment.created",
        version: 1,
        payload: { instanceId: "i-1", actorId: "u-author", commentId: "c-1" },
      },
    });

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "notifications:push",
      expect.stringContaining('"kind":"room"'),
    );
    const [, raw] = mockRedisPublish.mock.calls.find(
      ([, body]) => typeof body === "string" && body.includes('"kind":"room"'),
    ) as [string, string];
    const parsed = JSON.parse(raw) as {
      tenantId: string;
      instanceId: string;
      message: { type: string; comment: { body: string; authorId: string } };
    };
    expect(parsed.tenantId).toBe("t-1");
    expect(parsed.instanceId).toBe("i-1");
    expect(parsed.message.type).toBe("comment.created");
    expect(parsed.message.comment.body).toBe("hello world");
    expect(parsed.message.comment.authorId).toBe("u-author");
  });

  it("publishes a room-kind push for access_request.updated with the resolved status", async () => {
    accessRequestRow = {
      requesterId: "u-requester",
      status: "approved",
      resolvedBy: "u-owner",
      resolvedAt: new Date("2026-01-02T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    await capturedProcessor!({
      data: {
        outboxEventId: "evt-3",
        tenantId: "t-1",
        eventType: "access_request.updated",
        version: 1,
        payload: {
          instanceId: "i-1",
          actorId: "u-owner",
          requestId: "r-1",
          status: "approved",
        },
      },
    });

    const [, raw] = mockRedisPublish.mock.calls.find(
      ([, body]) => typeof body === "string" && body.includes('"kind":"room"'),
    ) as [string, string];
    const parsed = JSON.parse(raw) as {
      message: { type: string; request: { status: string } };
    };
    expect(parsed.message.type).toBe("access_request.updated");
    expect(parsed.message.request.status).toBe("approved");
  });

  it("does not publish a room push when the referenced comment can't be found", async () => {
    commentRow = null;

    await capturedProcessor!({
      data: {
        outboxEventId: "evt-4",
        tenantId: "t-1",
        eventType: "comment.created",
        version: 1,
        payload: {
          instanceId: "i-1",
          actorId: "u-author",
          commentId: "c-missing",
        },
      },
    });

    const roomPush = mockRedisPublish.mock.calls.find(
      ([, body]) => typeof body === "string" && body.includes('"kind":"room"'),
    );
    expect(roomPush).toBeUndefined();
  });
});
