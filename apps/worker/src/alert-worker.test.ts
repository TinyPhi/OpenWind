import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("./queues.js", () => ({
  connection: {},
  notifyOutboundQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("./notification-templates.js", () => ({
  buildRecordLink: vi.fn().mockResolvedValue("/records/tickets/instance-1"),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRedisPublish = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({ publish: mockRedisPublish })),
  NOTIFICATION_PUSH_CHANNEL: "notification:push",
}));

const mockTxSelectLimit = vi.fn();
const mockTxSelectWhere = vi.fn(() => ({ limit: mockTxSelectLimit }));
const mockTxSelectFrom = vi.fn(() => ({ where: mockTxSelectWhere }));
const mockTxSelect = vi.fn(() => ({ from: mockTxSelectFrom }));

const mockTxInsertReturning = vi
  .fn()
  .mockResolvedValue([{ id: "notification-1" }]);
const mockTxInsertValues = vi.fn(() => ({ returning: mockTxInsertReturning }));
const mockTxInsert = vi.fn(() => ({ values: mockTxInsertValues }));

const mockTxUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockTxUpdateSet = vi.fn(() => ({ where: mockTxUpdateWhere }));
const mockTxUpdate = vi.fn(() => ({ set: mockTxUpdateSet }));

// Both the main fire transaction and the post-fire link-attach update go
// through withTenantContext (ticket_alerts/notifications/notification_
// recipients all have tenant RLS — a plain db.transaction() leaves
// app.tenant_id unset and RLS rejects every query). Reused for both calls.
const mockWithTenantContext = vi.fn(
  async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: mockTxSelect,
      insert: mockTxInsert,
      update: mockTxUpdate,
    }),
);

const isOutboundNotificationsEnabledMock = vi.fn().mockResolvedValue(true);

vi.mock("@platform/db", () => ({
  withTenantContext: mockWithTenantContext,
  ticketAlerts: "ticket_alerts_mock",
  notifications: { id: "notifications_id_mock" },
  notificationRecipients: "notification_recipients_mock",
  isOutboundNotificationsEnabled: isOutboundNotificationsEnabledMock,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
}));

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(overrides: { alertId?: string; tenantId?: string } = {}) {
  return {
    id: "job-1",
    data: {
      alertId: overrides.alertId ?? "alert-1",
      tenantId: overrides.tenantId ?? "tenant-111",
      fireAt: new Date().toISOString(),
    },
  };
}

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-1",
    tenantId: "tenant-111",
    instanceId: "instance-1",
    createdBy: "user-owner",
    note: "test",
    scope: "me",
    status: "pending",
    recipientsSnapshot: null,
    ...overrides,
  };
}

await import("./alert-worker.js");

describe("alertWorker processor (§R5, §R7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxInsertReturning.mockResolvedValue([{ id: "notification-1" }]);
    isOutboundNotificationsEnabledMock.mockResolvedValue(true);
    mockRedisPublish.mockResolvedValue(undefined);
  });

  it("fires: writes a notification + recipient, flips status to 'fired' when pending", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([alertRow()]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).toHaveBeenCalledWith({ id: "notifications_id_mock" });
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ticket.alert" }),
    );
    expect(mockTxUpdate).toHaveBeenCalledWith("ticket_alerts_mock");
    expect(mockTxUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "fired" }),
    );
  });

  it("is idempotent: an already-fired alert is a no-op, no new notification", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([alertRow({ status: "fired" })]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent: a cancelled alert is a no-op", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      alertRow({ status: "cancelled" }),
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("skips without writing when the alert row no longer exists", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("scope='me' notifies only createdBy", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      alertRow({ scope: "me", createdBy: "user-owner" }),
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsertValues).toHaveBeenCalledWith([
      expect.objectContaining({ userId: "user-owner" }),
    ]);
  });

  it("scope='all' notifies every id in recipientsSnapshot, not re-derived from live access", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      alertRow({
        scope: "all",
        createdBy: "user-owner",
        recipientsSnapshot: ["user-owner", "user-mate"],
      }),
    ]);

    await capturedProcessor!(makeJob());

    const recipientCalls = mockTxInsertValues.mock.calls.find((call) =>
      Array.isArray(call[0]),
    );
    expect(recipientCalls?.[0]).toEqual([
      expect.objectContaining({ userId: "user-owner" }),
      expect.objectContaining({ userId: "user-mate" }),
    ]);
  });

  it("publishes a live push to NOTIFICATION_PUSH_CHANNEL for each recipient — without this, the recipient only sees the alert on their next refresh, not live", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      alertRow({
        scope: "all",
        createdBy: "user-owner",
        recipientsSnapshot: ["user-owner", "user-mate"],
      }),
    ]);

    await capturedProcessor!(makeJob({ tenantId: "tenant-111" }));

    expect(mockRedisPublish).toHaveBeenCalledTimes(2);
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "notification:push",
      expect.stringContaining('"userId":"user-owner"'),
    );
    expect(mockRedisPublish).toHaveBeenCalledWith(
      "notification:push",
      expect.stringContaining('"userId":"user-mate"'),
    );
  });

  it("derives the notification title and body from the alert's note (regression: recipients must see what the alert is about, not a generic message)", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      alertRow({ note: "Follow up with vendor" }),
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Follow up with vendor alert",
        body: "Follow up with vendor alert",
      }),
    );
  });

  it("publishes the same note-derived title/body in the live push as was written to the DB", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      alertRow({ note: "Call the client back" }),
    ]);

    await capturedProcessor!(makeJob());

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "notification:push",
      expect.stringContaining('"title":"Call the client back alert"'),
    );
  });

  it("enqueues the outbound handoff only when the kill switch is enabled", async () => {
    const { notifyOutboundQueue } = await import("./queues.js");
    mockTxSelectLimit.mockResolvedValueOnce([alertRow()]);
    isOutboundNotificationsEnabledMock.mockResolvedValueOnce(false);

    await capturedProcessor!(makeJob());

    expect(notifyOutboundQueue.add).not.toHaveBeenCalled();
  });
});
