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
const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockTxUpdate = vi.fn(() => ({ set: mockUpdateSet }));
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
    mockTicketAlertsQueueAdd.mockResolvedValue({ id: "job-1" });
    mockUpdateWhere.mockResolvedValue([]);
  });

  it("enqueues a fresh event with the deterministic alert-{alertId} job id (dash, not colon — BullMQ rejects colons in custom job ids)", async () => {
    const row = makeRow();
    mockTxExecute.mockResolvedValueOnce([row]);

    await tick();

    expect(mockTicketAlertsQueueAdd).toHaveBeenCalledWith(
      "alert.fire",
      expect.objectContaining({ alertId: "alert-aaa", tenantId: "tenant-111" }),
      expect.objectContaining({ jobId: "alert-alert-aaa" }),
    );
  });

  it("switches to the BYPASSRLS outbox_sweeper role for this cross-tenant sweep (#125 hotfix)", async () => {
    mockTxExecute.mockResolvedValueOnce([makeRow()]);

    await tick();

    expect(mockSetOutboxSweeperRole).toHaveBeenCalled();
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

  it("per-row isolation: one row's enqueue failure does not block the rest of the batch from being marked delivered (regression for the colon-in-jobId incident's failure mode)", async () => {
    const good = makeRow({ id: "outbox-good", alertId: "alert-good" });
    const bad = makeRow({ id: "outbox-bad", alertId: "alert-bad" });
    mockTxExecute.mockResolvedValueOnce([good, bad]);
    mockTicketAlertsQueueAdd.mockImplementation(
      (_name, data: { alertId: string }) => {
        if (data.alertId === "alert-bad") {
          return Promise.reject(new Error("Custom Id cannot contain :"));
        }
        return Promise.resolve({ id: "job-1" });
      },
    );

    await tick();

    // Both were attempted...
    expect(mockTicketAlertsQueueAdd).toHaveBeenCalledTimes(2);
    // ...but only the successful row is marked delivered; the failed row is
    // left delivered_at=NULL so the next tick retries just it.
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    const deliveredIds = (
      mockUpdateWhere.mock.calls[0]?.[0] as { vals: string[] }
    ).vals;
    expect(deliveredIds).toEqual(["outbox-good"]);
    expect(deliveredIds).not.toContain("outbox-bad");
  });

  it("does not mark anything delivered if every row in the batch fails to enqueue", async () => {
    const row = makeRow();
    mockTxExecute.mockResolvedValueOnce([row]);
    mockTicketAlertsQueueAdd.mockRejectedValue(new Error("boom"));

    await tick();

    expect(mockTxUpdate).not.toHaveBeenCalled();
  });
});
