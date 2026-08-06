import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("./queues.js", () => ({
  connection: {},
  slaQueue: { add: vi.fn() },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTxSelectLimit = vi.fn();
const mockTxSelectWhere = vi.fn(() => ({ limit: mockTxSelectLimit }));
const mockTxSelectFrom = vi.fn(() => ({ where: mockTxSelectWhere }));
const mockTxSelect = vi.fn(() => ({ from: mockTxSelectFrom }));

const mockTxExecute = vi.fn().mockResolvedValue([]);
const mockTxInsertValues = vi.fn().mockResolvedValue([]);
const mockTxInsert = vi.fn(() => ({ values: mockTxInsertValues }));

const mockWithTenantContext = vi.fn(
  async (_tenantId: string, fn: (tx: unknown) => Promise<void>) => {
    await fn({
      select: mockTxSelect,
      insert: mockTxInsert,
      execute: mockTxExecute,
    });
  },
);

vi.mock("@platform/db", () => ({
  withTenantContext: (...args: unknown[]) =>
    mockWithTenantContext(
      ...(args as Parameters<typeof mockWithTenantContext>),
    ),
  outboxEvents: "outbox_events_mock",
  entityInstances: "entity_instances_mock",
  deadLetterEvents: "dead_letter_events_mock",
  isTenantActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  sql: vi.fn((..._args: unknown[]) => ({ op: "sql" })),
}));

vi.mock("@platform/workflow-engine", () => ({}));

// BullMQ Worker is mocked so we capture processor and "failed" handler directly
let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;
const capturedFailedHandlers: Array<(job: unknown, err: Error) => void> = [];

// vitest 4.x: mockImplementation must use a regular function (not arrow) when
// the mock is used with `new` — arrow functions are not constructable.
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return {
      on: vi.fn(
        (event: string, handler: (job: unknown, err: Error) => void) => {
          if (event === "failed") capturedFailedHandlers.push(handler);
        },
      ),
      close: vi.fn(),
    };
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(
  overrides: { fireAt?: string; attemptsMade?: number; attempts?: number } = {},
) {
  return {
    id: "job-1",
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 3 },
    data: {
      outboxEventId: "outbox-aaa",
      tenantId: "tenant-111",
      instanceId: "instance-222",
      workflowId: "workflow-333",
      stateName: "in_review",
      slaHours: 24,
      fireAt: overrides.fireAt ?? new Date().toISOString(),
    },
  };
}

const BASE_JOB = makeJob();

// ── Import after mocks ────────────────────────────────────────────────────────

await import("./sla-breacher.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("slaBreacher processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxSelectLimit.mockResolvedValue([]);
    mockTxExecute.mockResolvedValue([]);
  });

  it("writes workflow.sla_breached outbox event when instance is still in expected state", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { currentState: "in_review", entityTypeId: "etype-aaa" },
    ]);

    await capturedProcessor!(BASE_JOB);

    expect(mockTxInsert).toHaveBeenCalledWith("outbox_events_mock");
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "workflow.sla_breached",
        tenantId: "tenant-111",
      }),
    );
  });

  it("skips without writing when instance has already transitioned", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { currentState: "resolved", entityTypeId: "etype-aaa" },
    ]);

    await capturedProcessor!(BASE_JOB);

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("skips without writing when instance is not found", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([]);

    await capturedProcessor!(BASE_JOB);

    expect(mockTxInsert).not.toHaveBeenCalled();
  });

  it("uses correct schema field names — state, breachedAt, entityTypeId (M1)", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { currentState: "in_review", entityTypeId: "etype-bbb" },
    ]);

    await capturedProcessor!(BASE_JOB);

    const payload = mockTxInsertValues.mock.calls[0]?.[0]?.payload as Record<
      string,
      unknown
    >;
    // M1: field names must match WorkflowSlaBreachedV1Schema
    expect(payload).toMatchObject({
      state: "in_review", // not stateName
      breachedAt: expect.any(String), // not occurredAt
      entityTypeId: "etype-bbb", // was missing entirely
      workflowId: "workflow-333",
      slaHours: 24,
    });
    // Negative assertions — old wrong names must not be present
    expect(payload).not.toHaveProperty("stateName");
    expect(payload).not.toHaveProperty("occurredAt");
  });

  it("wraps guard SELECT and INSERT in withTenantContext scoped to job tenantId (G1 + #243)", async () => {
    mockTxSelectLimit.mockResolvedValueOnce([
      { currentState: "in_review", entityTypeId: "etype-aaa" },
    ]);

    await capturedProcessor!(BASE_JOB);

    // withTenantContext establishes SET LOCAL ROLE app_user + tenant GUC
    expect(mockWithTenantContext).toHaveBeenCalledWith(
      BASE_JOB.data.tenantId,
      expect.any(Function),
    );
    expect(mockTxSelect).toHaveBeenCalled();
    expect(mockTxInsert).toHaveBeenCalled();
  });

  describe("late-firing warning", () => {
    it("logs a warning when the job fires more than 15 min past its fireAt", async () => {
      const fireAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      mockTxSelectLimit.mockResolvedValueOnce([
        { currentState: "in_review", entityTypeId: "etype-aaa" },
      ]);
      const { logger } = await import("@platform/logger");

      await capturedProcessor!(makeJob({ fireAt }));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ latencyMs: expect.any(Number) }),
        expect.stringContaining("fired significantly late"),
      );
    });

    it("does not warn when the job fires on time", async () => {
      const fireAt = new Date().toISOString();
      mockTxSelectLimit.mockResolvedValueOnce([
        { currentState: "in_review", entityTypeId: "etype-aaa" },
      ]);
      const { logger } = await import("@platform/logger");

      await capturedProcessor!(makeJob({ fireAt }));

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("still writes the breach event even when the job fires late", async () => {
      const fireAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      mockTxSelectLimit.mockResolvedValueOnce([
        { currentState: "in_review", entityTypeId: "etype-aaa" },
      ]);

      await capturedProcessor!(makeJob({ fireAt }));

      expect(mockTxInsert).toHaveBeenCalledOnce();
    });
  });

  describe("retry exhaustion dead-letter (G2)", () => {
    it("writes to dead_letter_events via withTenantContext when job is exhausted (#243)", async () => {
      const exhaustedJob = makeJob({ attemptsMade: 3, attempts: 3 });
      const err = new Error("DB connection lost");

      for (const handler of capturedFailedHandlers) {
        handler(exhaustedJob, err);
      }

      // The "failed" handler is fire-and-forget (void); flush the microtask
      // queue so the withTenantContext promise resolves before we assert.
      await Promise.resolve();
      await Promise.resolve();

      // DLQ write goes through withTenantContext — not a bare db.insert() or
      // manual set_config (withTenantContext handles role + GUC internally).
      expect(mockWithTenantContext).toHaveBeenCalledWith(
        "tenant-111",
        expect.any(Function),
      );

      expect(mockTxInsert).toHaveBeenCalledWith("dead_letter_events_mock");
      expect(mockTxInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-111",
          originalEventId: "outbox-aaa",
          eventType: "workflow.sla_breached",
          error: "DB connection lost",
          attemptCount: 3,
        }),
      );
    });

    it("does not write to dead_letter_events on non-exhausted failures", async () => {
      const nonExhaustedJob = makeJob({ attemptsMade: 1, attempts: 3 });
      const err = new Error("transient error");
      mockWithTenantContext.mockClear();

      for (const handler of capturedFailedHandlers) {
        handler(nonExhaustedJob, err);
      }

      await Promise.resolve();
      await Promise.resolve();

      expect(mockWithTenantContext).not.toHaveBeenCalled();
    });
  });
});
