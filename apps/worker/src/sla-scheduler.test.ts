import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSlaQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });

vi.mock("./queues.js", () => ({
  slaQueue: { add: mockSlaQueueAdd },
  connection: {},
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTxExecute = vi.fn().mockResolvedValue([]);
const mockTxUpdate = vi.fn(() => ({
  set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
}));
const mockTxInsert = vi.fn(() => ({
  values: vi.fn().mockResolvedValue([]),
}));
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({
    execute: mockTxExecute,
    update: mockTxUpdate,
    insert: mockTxInsert,
  });
});

const mockSetOutboxSweeperRole = vi.fn();

vi.mock("@platform/db", () => ({
  db: { transaction: mockTransaction },
  outboxEvents: "outbox_events_mock",
  deadLetterEvents: "dead_letter_events_mock",
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
  overrides: Partial<{
    id: string;
    tenant_id: string;
    fireAt: string;
  }> = {},
) {
  const fireAt =
    overrides.fireAt ?? new Date(Date.now() + 3_600_000).toISOString();
  return {
    id: overrides.id ?? "outbox-aaa",
    tenant_id: overrides.tenant_id ?? "tenant-111",
    payload: {
      instanceId: "instance-222",
      workflowId: "workflow-333",
      stateName: "in_review",
      slaHours: 24,
      fireAt,
    },
  };
}

// ── Import after mocks ────────────────────────────────────────────────────────

const { tick, startSlaScheduler, stopSlaScheduler, STALE_SLA_THRESHOLD_MS } =
  await import("./sla-scheduler.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SLA scheduler tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues a delayed BullMQ job with jobId=sla:{outboxEventId}", async () => {
    const row = makeRow({ id: "outbox-abc" });
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockSlaQueueAdd).toHaveBeenCalledWith(
      "sla.breach",
      expect.objectContaining({
        outboxEventId: "outbox-abc",
        instanceId: "instance-222",
        stateName: "in_review",
      }),
      expect.objectContaining({ jobId: "sla:outbox-abc" }),
    );
  });

  it("computes delay from fireAt — future fireAt results in positive delay", async () => {
    const fireAt = new Date(Date.now() + 7_200_000).toISOString(); // 2 h from now
    mockTxExecute.mockResolvedValueOnce([makeRow({ fireAt })]);

    await tick();

    const opts = mockSlaQueueAdd.mock.calls[0]?.[2] as { delay?: number };
    expect(opts.delay).toBeGreaterThan(0);
  });

  it("uses delay=0 when fireAt is in the past but within stale threshold", async () => {
    const fireAt = new Date(Date.now() - 5_000).toISOString(); // 5 s ago
    mockTxExecute.mockResolvedValueOnce([makeRow({ fireAt })]);

    await tick();

    const opts = mockSlaQueueAdd.mock.calls[0]?.[2] as { delay?: number };
    expect(opts.delay).toBe(0);
  });

  it("marks outbox events as delivered after enqueueing", async () => {
    mockTxExecute.mockResolvedValueOnce([makeRow()]);

    await tick();

    expect(mockTxUpdate).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no undelivered SLA outbox events", async () => {
    mockTxExecute.mockResolvedValueOnce([]);

    await tick();

    expect(mockSlaQueueAdd).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("logs and swallows errors so the poller keeps running", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("DB unavailable"));
    const { logger } = await import("@platform/logger");

    await tick();

    expect(logger.error).toHaveBeenCalled();
  });

  describe("stale event dead-lettering", () => {
    it("dead-letters events whose fireAt exceeds the stale threshold", async () => {
      // fireAt is 49 hours ago — exceeds 48 h threshold
      const fireAt = new Date(
        Date.now() - STALE_SLA_THRESHOLD_MS - 3_600_000,
      ).toISOString();
      const row = makeRow({ id: "outbox-stale", fireAt });
      mockTxExecute.mockResolvedValueOnce([row]);

      await tick();

      // Must NOT enqueue a BullMQ job
      expect(mockSlaQueueAdd).not.toHaveBeenCalled();

      // Must insert into dead_letter_events
      expect(mockTxInsert).toHaveBeenCalledWith("dead_letter_events_mock");
      const insertValues = mockTxInsert.mock.results[0]?.value.values;
      expect(insertValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            tenantId: "tenant-111",
            originalEventId: "outbox-stale",
            eventType: "workflow.sla_scheduled",
          }),
        ]),
      );
    });

    it("still marks stale outbox events as delivered", async () => {
      const fireAt = new Date(
        Date.now() - STALE_SLA_THRESHOLD_MS - 3_600_000,
      ).toISOString();
      mockTxExecute.mockResolvedValueOnce([makeRow({ fireAt })]);

      await tick();

      expect(mockTxUpdate).toHaveBeenCalledOnce();
    });

    it("warns when dead-lettering stale events", async () => {
      const fireAt = new Date(
        Date.now() - STALE_SLA_THRESHOLD_MS - 3_600_000,
      ).toISOString();
      mockTxExecute.mockResolvedValueOnce([makeRow({ fireAt })]);
      const { logger } = await import("@platform/logger");

      await tick();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ count: 1 }),
        expect.stringContaining("dead-lettered stale events"),
      );
    });

    it("issues SET LOCAL ROLE app_user and set_config before each dead_letter_events INSERT so RLS is enforced (#244)", async () => {
      const fireAt = new Date(
        Date.now() - STALE_SLA_THRESHOLD_MS - 3_600_000,
      ).toISOString();
      mockTxExecute.mockResolvedValueOnce([makeRow({ fireAt })]);

      await tick();

      // The sql mock captures the first template string chunk in .text.
      // Per-tenant dead-letter loop must issue both:
      //   1. SET LOCAL ROLE app_user   (switches to non-superuser for RLS)
      //   2. SELECT set_config(...)    (sets app.tenant_id GUC)
      const sqlTexts = mockTxExecute.mock.calls.map(
        (call) => (call[0] as { op?: string; text?: string })?.text ?? "",
      );
      expect(sqlTexts).toContain("SET LOCAL ROLE app_user");
      expect(sqlTexts.some((t) => t.includes("set_config"))).toBe(true);
    });

    it("restores outbox_sweeper after the per-tenant dead-letter loop before the final delivered_at UPDATE (#125 hotfix)", async () => {
      const fireAt = new Date(
        Date.now() - STALE_SLA_THRESHOLD_MS - 3_600_000,
      ).toISOString();
      mockTxExecute.mockResolvedValueOnce([makeRow({ fireAt })]);

      await tick();

      // Once at tick start for the cross-tenant SELECT, once more after the
      // stale loop switched down to app_user — without this second call the
      // final UPDATE would silently only affect the last tenant touched by
      // that loop under RLS (see setOutboxSweeperRole's doc comment).
      expect(mockSetOutboxSweeperRole).toHaveBeenCalledTimes(2);
    });

    it("dead-letters events with a malformed (NaN) fireAt instead of enqueuing with NaN delay", async () => {
      const row = makeRow({ id: "outbox-nan", fireAt: "not-a-date" });
      mockTxExecute.mockResolvedValueOnce([row]);

      await tick();

      // Must NOT enqueue — NaN delay would cause BullMQ to fire immediately
      // and propagate NaN into the breacher's latency computation
      expect(mockSlaQueueAdd).not.toHaveBeenCalled();

      // Must dead-letter the malformed row
      expect(mockTxInsert).toHaveBeenCalledWith("dead_letter_events_mock");

      // Must still mark as delivered
      expect(mockTxUpdate).toHaveBeenCalledOnce();
    });

    it("enqueues fresh events and dead-letters stale ones in the same batch", async () => {
      const futureFireAt = new Date(Date.now() + 3_600_000).toISOString();
      const staleFireAt = new Date(
        Date.now() - STALE_SLA_THRESHOLD_MS - 3_600_000,
      ).toISOString();
      mockTxExecute.mockResolvedValueOnce([
        makeRow({ id: "outbox-fresh", fireAt: futureFireAt }),
        makeRow({ id: "outbox-stale", fireAt: staleFireAt }),
      ]);

      await tick();

      // One BullMQ job for the fresh event
      expect(mockSlaQueueAdd).toHaveBeenCalledOnce();
      expect(mockSlaQueueAdd).toHaveBeenCalledWith(
        "sla.breach",
        expect.objectContaining({ outboxEventId: "outbox-fresh" }),
        expect.anything(),
      );

      // One dead-letter insert for the stale event
      expect(mockTxInsert).toHaveBeenCalledWith("dead_letter_events_mock");

      // Both rows marked as delivered
      expect(mockTxUpdate).toHaveBeenCalledOnce();
    });
  });

  describe("startSlaScheduler", () => {
    it("fires the first tick immediately on startup without waiting for the interval", async () => {
      vi.useFakeTimers();
      mockTxExecute.mockResolvedValue([]);

      startSlaScheduler(10_000);

      // At t=0, before any interval fires, the transaction mock should already
      // have been called by the immediate first tick.
      await Promise.resolve(); // flush microtask queue
      expect(mockTransaction).toHaveBeenCalled();

      await stopSlaScheduler();
      vi.useRealTimers();
    });

    it("skips a scheduled interval tick if the previous tick is still running", async () => {
      vi.useFakeTimers();

      let resolveTick!: () => void;
      const slowTick = new Promise<void>((res) => {
        resolveTick = res;
      });

      // Make the transaction hang so activeTick is never cleared
      mockTransaction.mockImplementationOnce(() => slowTick);
      mockTxExecute.mockResolvedValue([]);

      startSlaScheduler(100);
      await Promise.resolve(); // let the immediate tick start

      // Advance past one interval — a second tick should be skipped because
      // the first is still in-flight
      vi.advanceTimersByTime(150);
      await Promise.resolve();

      // Only one transaction should have started despite the interval firing
      expect(mockTransaction).toHaveBeenCalledTimes(1);

      resolveTick();
      await stopSlaScheduler();
      vi.useRealTimers();
    });
  });
});
