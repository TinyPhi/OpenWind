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

const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    select: mockTxSelect,
    insert: mockTxInsert,
    update: mockTxUpdate,
  }),
);

const mockDbUpdateWhere = vi.fn().mockReturnValue({ catch: vi.fn() });
const mockDbUpdateSet = vi.fn(() => ({ where: mockDbUpdateWhere }));
const mockDbUpdate = vi.fn(() => ({ set: mockDbUpdateSet }));

const isOutboundNotificationsEnabledMock = vi.fn().mockResolvedValue(true);

vi.mock("@platform/db", () => ({
  db: { transaction: mockTransaction, update: mockDbUpdate },
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

  it("enqueues the outbound handoff only when the kill switch is enabled", async () => {
    const { notifyOutboundQueue } = await import("./queues.js");
    mockTxSelectLimit.mockResolvedValueOnce([alertRow()]);
    isOutboundNotificationsEnabledMock.mockResolvedValueOnce(false);

    await capturedProcessor!(makeJob());

    expect(notifyOutboundQueue.add).not.toHaveBeenCalled();
  });
});
