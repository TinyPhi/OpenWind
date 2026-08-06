import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("./queues.js", () => ({
  connection: {},
  dueDateQueue: { add: vi.fn() },
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

const DUE_DATE = "2026-01-01T00:00:00.000Z";

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

await import("./due-date-worker.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dueDateWorker processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelectLimit.mockResolvedValue([]);
  });

  it("writes entity.due_date_overdue outbox event when due_date is unchanged", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { dueDate: new Date(DUE_DATE), deletedAt: null },
    ]);

    await capturedProcessor!(makeJob());

    expect(mockTxInsert).toHaveBeenCalledWith("outbox_events_mock");
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "entity.due_date_overdue",
        tenantId: "tenant-111",
      }),
    );
  });

  it("skips without writing when the instance's due_date has changed since scheduling", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { dueDate: new Date("2026-02-01T00:00:00.000Z"), deletedAt: null },
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
