import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
const mockUpdate = vi.fn();
const mockAdd = vi.fn();
const mockSetOutboxSweeperRole = vi.fn();

vi.mock("@platform/db", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        execute: mockExecute,
        update: () => ({
          set: () => ({
            where: mockUpdate,
          }),
        }),
      });
    },
  },
  outboxEvents: {
    id: "id",
    notifiedDeliveredAt: "notifiedDeliveredAt",
  },
  setOutboxSweeperRole: mockSetOutboxSweeperRole,
}));

vi.mock("drizzle-orm", () => {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    _sql: strings,
    _values: values,
  });
  sqlFn.join = (parts: unknown[], sep: unknown) => ({ parts, sep });
  return {
    sql: sqlFn,
    inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  };
});

vi.mock("./queues.js", () => ({
  notifyQueue: { add: (...args: unknown[]) => mockAdd(...args) },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { startNotificationPoller, stopNotificationPoller } =
  await import("./notification-poller.js");

const fakeRow = {
  id: "00000000-0000-0000-0000-000000000002",
  tenant_id: "t-aaa",
  event_type: "comment.mentioned",
  version: 1,
  payload: { eventType: "comment.mentioned" },
};

describe("notification poller tick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues undelivered rows and marks them notified-delivered", async () => {
    mockExecute.mockResolvedValue([fakeRow]);
    mockUpdate.mockResolvedValue(undefined);
    mockAdd.mockResolvedValue(undefined);

    startNotificationPoller(50);
    await new Promise((r) => setTimeout(r, 100));
    await stopNotificationPoller();

    expect(mockAdd).toHaveBeenCalledWith(
      "comment.mentioned",
      expect.objectContaining({
        outboxEventId: fakeRow.id,
        tenantId: fakeRow.tenant_id,
      }),
      expect.objectContaining({ jobId: fakeRow.id }),
    );
    expect(mockUpdate).toHaveBeenCalled();
    // This sweep is cross-tenant — it must switch to the BYPASSRLS
    // outbox_sweeper role or every mention/notification event is silently
    // dropped under RLS (#125 hotfix, 0053_outbox_sweeper_role.sql). This is
    // the exact production outage this fix closes.
    expect(mockSetOutboxSweeperRole).toHaveBeenCalled();
  });

  it("does not call queue.add when no undelivered rows", async () => {
    mockExecute.mockResolvedValue([]);

    startNotificationPoller(50);
    await new Promise((r) => setTimeout(r, 100));
    await stopNotificationPoller();

    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("stops cleanly after stopNotificationPoller", async () => {
    mockExecute.mockResolvedValue([]);

    startNotificationPoller(50);
    await stopNotificationPoller();

    const callCountAfterStop = mockExecute.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecute.mock.calls.length).toBe(callCountAfterStop);
  });
});
