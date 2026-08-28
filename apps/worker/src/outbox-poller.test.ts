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
    deliveredAt: "deliveredAt",
  },
  setOutboxSweeperRole: mockSetOutboxSweeperRole,
}));

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    _sql: strings,
    _values: values,
  }),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
}));

vi.mock("./queues.js", () => ({
  automationQueue: { add: (...args: unknown[]) => mockAdd(...args) },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { startOutboxPoller, stopOutboxPoller } =
  await import("./outbox-poller.js");

const fakeRow = {
  id: "00000000-0000-0000-0000-000000000001",
  tenant_id: "t-aaa",
  event_type: "workflow.transitioned",
  version: 1,
  payload: { eventType: "workflow.transitioned" },
};

describe("outbox poller tick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues undelivered rows and marks them delivered", async () => {
    mockExecute.mockResolvedValue([fakeRow]);
    mockUpdate.mockResolvedValue(undefined);
    mockAdd.mockResolvedValue(undefined);

    startOutboxPoller(50);
    await new Promise((r) => setTimeout(r, 100));
    await stopOutboxPoller();

    expect(mockAdd).toHaveBeenCalledWith(
      "workflow.transitioned",
      expect.objectContaining({
        outboxEventId: fakeRow.id,
        tenantId: fakeRow.tenant_id,
      }),
      // jobId deduplicates re-enqueues on transaction retry (M2 fix)
      expect.objectContaining({ jobId: fakeRow.id }),
    );
    expect(mockUpdate).toHaveBeenCalled();
    // This sweep is cross-tenant — it must switch to the BYPASSRLS
    // outbox_sweeper role or every row is silently dropped under RLS (#125
    // hotfix, 0064_outbox_sweeper_role.sql).
    expect(mockSetOutboxSweeperRole).toHaveBeenCalled();
  });

  it("does not call queue.add when no undelivered rows", async () => {
    mockExecute.mockResolvedValue([]);

    startOutboxPoller(50);
    await new Promise((r) => setTimeout(r, 100));
    await stopOutboxPoller();

    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("stops cleanly after stopOutboxPoller", async () => {
    mockExecute.mockResolvedValue([]);

    startOutboxPoller(50);
    await stopOutboxPoller();

    const callCountAfterStop = mockExecute.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecute.mock.calls.length).toBe(callCountAfterStop);
  });
});
