import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("./queues.js", () => ({
  connection: {},
  dueDateApproachingQueue: { add: vi.fn() },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTxSelectLimit = vi.fn();
const mockTxSelectWhere = vi.fn(() => ({ limit: mockTxSelectLimit }));
const mockTxSelectFrom = vi.fn(() => ({ where: mockTxSelectWhere }));
const mockTxSelect = vi.fn(() => ({ from: mockTxSelectFrom }));

const mockTxInsertValues = vi.fn().mockResolvedValue([]);
const mockTxInsert = vi.fn(() => ({ values: mockTxInsertValues }));

const mockWithTenantContext = vi.fn(
  async (_tenantId: string, fn: (tx: unknown) => Promise<void>) => {
    await fn({ select: mockTxSelect, insert: mockTxInsert });
  },
);

vi.mock("@platform/db", () => ({
  withTenantContext: (...args: unknown[]) =>
    mockWithTenantContext(
      ...(args as Parameters<typeof mockWithTenantContext>),
    ),
  outboxEvents: "outbox_events_mock",
  entityInstances: "entity_instances_mock",
  isTenantActive: vi.fn().mockResolvedValue(true),
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

// 5 days out — must be in the future relative to "now" so the worker's own
// already-overdue guard doesn't short-circuit the happy-path tests.
const DUE_DATE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

function makeJob() {
  return {
    id: "job-1",
    data: {
      outboxEventId: "outbox-aaa",
      tenantId: "tenant-111",
      instanceId: "instance-222",
      entityTypeId: "etype-aaa",
      dueDate: DUE_DATE,
    },
  };
}

// ── Import after mocks ────────────────────────────────────────────────────────

await import("./due-date-approaching-worker.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dueDateApproachingWorker processor (§2.8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelectLimit.mockResolvedValue([]);
  });

  it("writes entity.due_date_approaching outbox event when due_date is unchanged and still in the future", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { dueDate: new Date(DUE_DATE), deletedAt: null },
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).toHaveBeenCalledWith("outbox_events_mock");
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "entity.due_date_approaching",
        tenantId: "tenant-111",
      }),
    );
  });

  it("skips without writing when the due date has already passed by the time the job runs", async () => {
    const pastDueDate = "2026-01-01T00:00:00.000Z";
    mockTxSelectLimit.mockResolvedValueOnce([
      { dueDate: new Date(pastDueDate), deletedAt: null },
    ]);

    await capturedProcessor!({
      id: "job-1",
      data: {
        outboxEventId: "outbox-aaa",
        tenantId: "tenant-111",
        instanceId: "instance-222",
        entityTypeId: "etype-aaa",
        dueDate: pastDueDate,
      },
    });

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("skips without writing when the instance's due_date has changed since scheduling", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      {
        dueDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        deletedAt: null,
      },
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("skips without writing when the instance's due_date was cleared since scheduling", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { dueDate: null, deletedAt: null },
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("skips without writing when the instance was archived/deleted since scheduling", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { dueDate: new Date(DUE_DATE), deletedAt: new Date() },
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("skips without writing when the instance is not found", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("aborts without touching the DB when the tenant is inactive", async () => {
    const { isTenantActive } = await import("@platform/db");
    (isTenantActive as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await capturedProcessor!(makeJob());

    expect(mockWithTenantContext).not.toHaveBeenCalled();
  });
});
