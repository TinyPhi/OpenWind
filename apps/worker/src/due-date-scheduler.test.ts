import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDueDateQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });
const mockDueDateApproachingQueueAdd = vi
  .fn()
  .mockResolvedValue({ id: "job-2" });

vi.mock("./queues.js", () => ({
  dueDateQueue: { add: mockDueDateQueueAdd },
  dueDateApproachingQueue: { add: mockDueDateApproachingQueueAdd },
  connection: {},
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTxExecute = vi.fn().mockResolvedValue([]);
const mockTxUpdate = vi.fn(() => ({
  set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
}));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({ execute: mockTxExecute, update: mockTxUpdate });
});

const mockSetOutboxSweeperRole = vi.fn();

vi.mock("@platform/db", () => ({
  db: { transaction: mockTransaction },
  outboxEvents: "outbox_events_mock",
  setOutboxSweeperRole: mockSetOutboxSweeperRole,
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => ({
    op: "sql",
    text: Array.isArray(strings) ? strings[0] : "",
  })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<{ id: string; tenant_id: string; dueDate: string }> = {},
) {
  const dueDate =
    overrides.dueDate ?? new Date(Date.now() + 3_600_000).toISOString();
  return {
    id: overrides.id ?? "outbox-aaa",
    tenant_id: overrides.tenant_id ?? "tenant-111",
    payload: {
      instanceId: "instance-222",
      entityTypeId: "type-333",
      dueDate,
    },
  };
}

// ── Import after mocks ────────────────────────────────────────────────────────

const {
  tick,
  startDueDateScheduler,
  stopDueDateScheduler,
  STALE_DUE_DATE_THRESHOLD_MS,
} = await import("./due-date-scheduler.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Due date scheduler tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues a delayed BullMQ job with jobId=duedate-{outboxEventId}", async () => {
    const row = makeRow({ id: "outbox-abc" });
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockDueDateQueueAdd).toHaveBeenCalledWith(
      "duedate.overdue",
      expect.objectContaining({
        outboxEventId: "outbox-abc",
        instanceId: "instance-222",
      }),
      expect.objectContaining({ jobId: "duedate-outbox-abc" }),
    );
  });

  it("switches to the BYPASSRLS outbox_sweeper role for this cross-tenant sweep (#125 hotfix)", async () => {
    mockTxExecute.mockResolvedValueOnce([makeRow()]);

    await tick();

    expect(mockSetOutboxSweeperRole).toHaveBeenCalled();
  });

  it("computes delay from dueDate — future dueDate results in positive delay", async () => {
    const dueDate = new Date(Date.now() + 7_200_000).toISOString();
    mockTxExecute.mockResolvedValueOnce([makeRow({ dueDate })]);

    await tick();

    const opts = mockDueDateQueueAdd.mock.calls[0]?.[2] as { delay?: number };
    expect(opts.delay).toBeGreaterThan(0);
  });

  it("uses delay=0 when dueDate is in the past but within stale threshold", async () => {
    const dueDate = new Date(Date.now() - 5_000).toISOString();
    mockTxExecute.mockResolvedValueOnce([makeRow({ dueDate })]);

    await tick();

    const opts = mockDueDateQueueAdd.mock.calls[0]?.[2] as { delay?: number };
    expect(opts.delay).toBe(0);
  });

  it("also enqueues an approaching-warning job, 2 days before the due date (§2.8)", async () => {
    const dueDate = new Date(
      Date.now() + 5 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 5 days out
    mockTxExecute.mockResolvedValueOnce([
      makeRow({ id: "outbox-abc", dueDate }),
    ]);

    await tick();

    expect(mockDueDateApproachingQueueAdd).toHaveBeenCalledWith(
      "duedate.approaching",
      expect.objectContaining({
        outboxEventId: "outbox-abc",
        instanceId: "instance-222",
      }),
      expect.objectContaining({ jobId: "duedate-approaching-outbox-abc" }),
    );
    const opts = mockDueDateApproachingQueueAdd.mock.calls[0]?.[2] as {
      delay?: number;
    };
    // ~3 days until the 2-day-prior mark (5 days out minus the 2-day lead).
    expect(opts.delay).toBeGreaterThan(2.9 * 24 * 60 * 60 * 1000);
    expect(opts.delay).toBeLessThan(3.1 * 24 * 60 * 60 * 1000);
  });

  it("uses delay=0 for the approaching job when already within the 2-day window", async () => {
    const dueDate = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour out
    mockTxExecute.mockResolvedValueOnce([makeRow({ dueDate })]);

    await tick();

    const opts = mockDueDateApproachingQueueAdd.mock.calls[0]?.[2] as {
      delay?: number;
    };
    expect(opts.delay).toBe(0);
  });

  it("does not enqueue an approaching job for a due date already in the past (overdue path covers it instead)", async () => {
    const dueDate = new Date(Date.now() - 5_000).toISOString();
    mockTxExecute.mockResolvedValueOnce([makeRow({ dueDate })]);

    await tick();

    expect(mockDueDateApproachingQueueAdd).not.toHaveBeenCalled();
  });

  it("marks outbox events as delivered after enqueueing", async () => {
    mockTxExecute.mockResolvedValueOnce([makeRow()]);

    await tick();

    expect(mockTxUpdate).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no undelivered due-date outbox events", async () => {
    mockTxExecute.mockResolvedValueOnce([]);

    await tick();

    expect(mockDueDateQueueAdd).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("skips enqueueing (but still marks delivered) events whose dueDate exceeds the stale threshold — no dead-lettering", async () => {
    const dueDate = new Date(
      Date.now() - STALE_DUE_DATE_THRESHOLD_MS - 3_600_000,
    ).toISOString();
    mockTxExecute.mockResolvedValueOnce([
      makeRow({ id: "outbox-stale", dueDate }),
    ]);

    await tick();

    // Never enqueued as a BullMQ job — a wildly late overdue trigger would
    // surprise recipients, matching alert-scheduler.ts's approach.
    expect(mockDueDateQueueAdd).not.toHaveBeenCalled();
    // The scheduling *marker* is still consumed so it isn't re-polled forever
    // — unlike SLA, there is no dead_letter_events write for it.
    expect(mockTxUpdate).toHaveBeenCalledOnce();
  });

  it("logs and swallows errors so the poller keeps running", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("DB unavailable"));
    const { logger } = await import("@platform/logger");

    await tick();

    expect(logger.error).toHaveBeenCalled();
  });

  describe("startDueDateScheduler", () => {
    it("fires the first tick immediately on startup without waiting for the interval", async () => {
      vi.useFakeTimers();
      mockTxExecute.mockResolvedValue([]);

      startDueDateScheduler(10_000);

      await Promise.resolve();
      expect(mockTransaction).toHaveBeenCalled();

      await stopDueDateScheduler();
      vi.useRealTimers();
    });
  });
});
