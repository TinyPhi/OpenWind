import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockTicketAlertsQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });

vi.mock("./queues.js", () => ({
  ticketAlertsQueue: { add: mockTicketAlertsQueueAdd },
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

vi.mock("@platform/db", () => ({
  db: { transaction: mockTransaction },
  outboxEvents: "outbox_events_mock",
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn((..._args: unknown[]) => ({ op: "sql" })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<{
    id: string;
    tenant_id: string;
    alertId: string;
    fireAt: string;
  }> = {},
) {
  const fireAt =
    overrides.fireAt ?? new Date(Date.now() + 3_600_000).toISOString();
  return {
    id: overrides.id ?? "outbox-aaa",
    tenant_id: overrides.tenant_id ?? "tenant-111",
    payload: {
      alertId: overrides.alertId ?? "alert-aaa",
      fireAt,
    },
  };
}

const { tick, STALE_ALERT_THRESHOLD_MS } = await import("./alert-scheduler.js");

describe("alert scheduler tick() (§R5, §V — independent of sla-scheduler.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxExecute.mockResolvedValue([]);
  });

  it("enqueues a fresh event with the deterministic alert:{alertId} job id", async () => {
    const row = makeRow();
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockTicketAlertsQueueAdd).toHaveBeenCalledWith(
      "alert.fire",
      expect.objectContaining({ alertId: "alert-aaa", tenantId: "tenant-111" }),
      expect.objectContaining({ jobId: "alert:alert-aaa" }),
    );
  });

  it("computes delay=0 for a fireAt already in the past but within the stale threshold", async () => {
    const row = makeRow({
      fireAt: new Date(Date.now() - 60_000).toISOString(),
    });
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockTicketAlertsQueueAdd).toHaveBeenCalledWith(
      "alert.fire",
      expect.anything(),
      expect.objectContaining({ delay: 0 }),
    );
  });

  it("does not enqueue an event older than the stale threshold — leaves it for the row's own pending status", async () => {
    const row = makeRow({
      fireAt: new Date(
        Date.now() - (STALE_ALERT_THRESHOLD_MS + 3_600_000),
      ).toISOString(),
    });
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockTicketAlertsQueueAdd).not.toHaveBeenCalled();
  });

  it("marks polled rows delivered (fresh and stale alike) so they are not re-processed", async () => {
    const row = makeRow();
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockTxUpdate).toHaveBeenCalledWith("outbox_events_mock");
  });

  it("does nothing when there are no undelivered rows", async () => {
    mockTxExecute.mockResolvedValueOnce([]);

    await tick();

    expect(mockTicketAlertsQueueAdd).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });
});
