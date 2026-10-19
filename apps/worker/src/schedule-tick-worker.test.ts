import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("@platform/config", () => ({
  env: {
    SCHEDULE_TICK_INTERVAL_SECONDS: 60,
    SCHEDULE_CATCH_UP_MAX: 24,
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const mockScheduleTickAdd = vi.fn();
const mockScheduleExecutionAdd = vi.fn();
const mockScheduleCatchUpAdd = vi.fn();
const mockTickDurationRecord = vi.fn();
const mockExecutionDurationRecord = vi.fn();
vi.mock("@platform/telemetry", () => ({
  scheduleTickDurationMs: {
    record: (...a: unknown[]) => mockTickDurationRecord(...a),
  },
  scheduleExecutionDurationMs: {
    record: (...a: unknown[]) => mockExecutionDurationRecord(...a),
  },
  scheduleTickTotal: { add: (...a: unknown[]) => mockScheduleTickAdd(...a) },
  scheduleExecutionTotal: {
    add: (...a: unknown[]) => mockScheduleExecutionAdd(...a),
  },
  scheduleCatchUpTotal: {
    add: (...a: unknown[]) => mockScheduleCatchUpAdd(...a),
  },
}));

const mockCreateEntity = vi.fn();
vi.mock("@platform/entity-engine", () => ({
  createEntity: (...args: unknown[]) => mockCreateEntity(...args),
  DEFAULT_TICKET_SEVERITY: "medium",
}));

const mockValidateScheduleRuleRefs = vi.fn().mockResolvedValue([]);
// computeNextFireAt: fixed 1-hour-ahead stub — the tests never depend on the
// real cron math, only on the claim/catch-up/fire control flow it feeds into.
const mockComputeNextFireAt = vi.fn(
  (_cronExpr: string, _tz: string, from: Date) =>
    new Date(from.getTime() + 3_600_000),
);
// Real schema (not a stub) -- G3's TemplateSchema.safeParse call in
// validateTemplate needs an actual zod object to parse against, not an
// undefined export, or every fireRule call throws a TypeError that gets
// misclassified as INTERNAL_ERROR before ever reaching the mocked
// createEntity/validateScheduleRuleRefs this suite is actually testing.
// Named with a "mock" prefix so vitest's hoisting of vi.mock() above this
// file's other statements doesn't throw a temporal-dead-zone reference error.
const mockTemplateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(10000).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  assignedTo: z.string().trim().min(1).max(255).optional(),
  teamId: z.string().uuid().optional(),
  service_id: z.string().uuid().optional(),
  due_days: z.number().int().min(0),
  remark: z.string().trim().min(1).max(4000),
  fields: z.record(z.string(), z.unknown()).optional(),
});
const mockPostScheduleRemarkComment = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/scheduler", () => ({
  computeNextFireAt: (...args: [string, string, Date]) =>
    mockComputeNextFireAt(...args),
  buildTemplateVariables: () => ({}),
  renderTemplate: (template: unknown) => template,
  TemplateSchema: mockTemplateSchema,
  validateScheduleRuleRefs: (...args: unknown[]) =>
    mockValidateScheduleRuleRefs(...args),
  postScheduleRemarkComment: (...args: unknown[]) =>
    mockPostScheduleRemarkComment(...args),
}));

let dueRules: unknown[] = [];
let claimRows: unknown[] = [];

const insertedExecutions: unknown[] = [];

// Lets a test advance a fake clock when a failed fire is recorded.
let onExecutionInsert: (() => void) | undefined;

const withTenantTx = {
  insert: (_table: unknown) => ({
    values: (values: unknown) => {
      onExecutionInsert?.();
      insertedExecutions.push(values);
      return Promise.resolve(undefined);
    },
  }),
};

const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(withTenantTx),
);

const mockSetScheduleSweeperRole = vi.fn(() => Promise.resolve(undefined));

// schedulerTick's cross-tenant poll (schedule_sweeper role, see
// 0107_schedule_sweeper_role.sql) runs inside its own db.transaction now,
// with a plain select().from().where() chain -- distinct from claimRule's
// transaction, which needs the fuller select().from().where().for().limit()
// + update() chain below.
let pollFails = false;
const pollTx = {
  select: () => ({
    from: () => ({
      where: () =>
        pollFails
          ? Promise.reject(new Error("db down"))
          : Promise.resolve(dueRules),
    }),
  }),
};

const claimTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        for: () => ({
          limit: () => Promise.resolve(claimRows),
        }),
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => Promise.resolve(undefined),
    }),
  }),
};

let transactionCallCount = 0;

const mockIsTenantActive = vi.fn().mockResolvedValue(true);

vi.mock("@platform/db", () => ({
  db: {
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn(transactionCallCount++ === 0 ? pollTx : claimTx),
  },
  isTenantActive: (tenantId: string) => mockIsTenantActive(tenantId),
  withTenantContext: (...args: [string, (tx: unknown) => Promise<unknown>]) =>
    mockWithTenantContext(...args),
  setScheduleSweeperRole: (...args: unknown[]) =>
    mockSetScheduleSweeperRole(...args),
  scheduleRules: "schedule_rules_table",
  scheduleExecutions: "schedule_executions_table",
  workflowEvents: "workflow_events_table",
}));

const { schedulerTick } = await import("./schedule-tick-worker.js");
const { logger } = await import("@platform/logger");

function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rule-1",
    tenantId: "tenant-1",
    name: "Weekly review",
    cronExpr: "0 9 * * 1",
    timezone: "UTC",
    entityTypeId: "et-1",
    workflowId: null,
    template: {
      title: "Weekly review",
      teamId: "22222222-2222-2222-2222-222222222222",
      due_days: 2,
      remark: "Auto-created by the weekly review rule.",
    },
    status: "active",
    nextFireAt: new Date(Date.now() - 1000),
    lastFiredAt: null,
    catchUp: false,
    createdBy: "u-creator",
    ...overrides,
  };
}

describe("schedulerTick", () => {
  beforeEach(() => {
    dueRules = [];
    claimRows = [];
    insertedExecutions.length = 0;
    onExecutionInsert = undefined;
    transactionCallCount = 0;
    mockWriteAuditEntry.mockClear();
    mockScheduleTickAdd.mockClear();
    mockScheduleExecutionAdd.mockClear();
    mockScheduleCatchUpAdd.mockClear();
    mockTickDurationRecord.mockClear();
    mockExecutionDurationRecord.mockClear();
    pollFails = false;
    mockCreateEntity.mockReset();
    mockValidateScheduleRuleRefs.mockReset().mockResolvedValue([]);
    mockWithTenantContext.mockClear();
    mockPostScheduleRemarkComment.mockClear().mockResolvedValue(undefined);
    mockSetScheduleSweeperRole.mockClear();
    mockIsTenantActive.mockReset().mockResolvedValue(true);
  });

  it("fires a due rule, creates a ticket, and records a success execution", async () => {
    const rule = makeRule();
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({ id: "ticket-1" });

    await schedulerTick();

    expect(mockCreateEntity).toHaveBeenCalledTimes(1);
    expect(insertedExecutions).toHaveLength(1);
    expect((insertedExecutions[0] as { status: string }).status).toBe(
      "success",
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "schedule.ticket_created" }),
    );
    expect(mockScheduleExecutionAdd).toHaveBeenCalledWith(1, {
      status: "success",
    });
    expect(mockScheduleTickAdd).toHaveBeenCalledWith(1, {
      outcome: "completed",
    });
  });

  describe("duration histograms (docs/temporal-scheduler-design.md §9.4)", () => {
    it("records one execution duration, labelled success, when a fire succeeds", async () => {
      const rule = makeRule();
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({ id: "ticket-1" });

      await schedulerTick();

      expect(mockExecutionDurationRecord).toHaveBeenCalledTimes(1);
      const [ms, attrs] = mockExecutionDurationRecord.mock.calls[0] as [
        number,
        Record<string, unknown>,
      ];
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(attrs).toEqual({ status: "success" });
    });

    it("records one execution duration, labelled failed with no error code, when a fire fails", async () => {
      const rule = makeRule();
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockRejectedValue(
        Object.assign(new Error("boom"), {
          name: "EntityError",
          code: "ENTITY_TYPE_NOT_FOUND",
        }),
      );

      await schedulerTick();

      expect(mockExecutionDurationRecord).toHaveBeenCalledTimes(1);
      const [ms, attrs] = mockExecutionDurationRecord.mock.calls[0] as [
        number,
        Record<string, unknown>,
      ];
      expect(ms).toBeGreaterThanOrEqual(0);
      // errorCode stays out of the histogram's labels: each code would
      // multiply every bucket series, and the counter already carries it.
      expect(attrs).toEqual({ status: "failed" });
    });

    it("measures a failed fire up to the failure, not the bookkeeping that records it", async () => {
      // Start from the real time: makeRule() derives nextFireAt from Date.now(),
      // and a rule far in the past would be treated as overdue and skipped.
      let now = Date.now();
      const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const rule = makeRule();
        dueRules = [rule];
        claimRows = [rule];
        mockCreateEntity.mockImplementation(() => {
          now += 300; // the fire attempt itself
          return Promise.reject(
            Object.assign(new Error("boom"), {
              name: "EntityError",
              code: "ENTITY_TYPE_NOT_FOUND",
            }),
          );
        });
        onExecutionInsert = () => {
          now += 700; // writing the failure row: must not count
        };

        await schedulerTick();

        expect(mockExecutionDurationRecord).toHaveBeenCalledWith(300, {
          status: "failed",
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("records a failed execution duration for every catch-up fire that fails", async () => {
      const rule = makeRule({
        catchUp: true,
        nextFireAt: new Date(Date.now() - 3 * 3_600_000),
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockRejectedValue(
        Object.assign(new Error("boom"), {
          name: "EntityError",
          code: "ENTITY_TYPE_NOT_FOUND",
        }),
      );

      await schedulerTick();

      const fires = mockScheduleExecutionAdd.mock.calls.length;
      expect(fires).toBeGreaterThan(1);
      expect(mockExecutionDurationRecord).toHaveBeenCalledTimes(fires);
      for (const [ms, attrs] of mockExecutionDurationRecord.mock.calls as [
        number,
        Record<string, unknown>,
      ][]) {
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(attrs).toEqual({ status: "failed" });
      }
    });

    it("records one tick duration when the tick completes", async () => {
      dueRules = [];

      await schedulerTick();

      expect(mockTickDurationRecord).toHaveBeenCalledTimes(1);
      expect(
        (mockTickDurationRecord.mock.calls[0] as [number])[0],
      ).toBeGreaterThanOrEqual(0);
    });

    it("records one tick duration, and counts the tick failed, when the poll throws", async () => {
      pollFails = true;

      await schedulerTick();

      expect(mockScheduleTickAdd).toHaveBeenCalledWith(1, {
        outcome: "failed",
      });
      expect(mockTickDurationRecord).toHaveBeenCalledTimes(1);
    });

    it("records an execution duration per catch-up fire, since they reuse fireRule", async () => {
      const rule = makeRule({
        catchUp: true,
        nextFireAt: new Date(Date.now() - 3 * 3_600_000),
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({ id: "ticket-1" });

      await schedulerTick();

      // The catch-up counter proves the overdue path ran, not the normal one.
      expect(mockScheduleCatchUpAdd).toHaveBeenCalledWith(1, {
        action: "executed",
      });
      const fires = mockScheduleExecutionAdd.mock.calls.length;
      expect(fires).toBeGreaterThan(1);
      expect(mockExecutionDurationRecord).toHaveBeenCalledTimes(fires);
    });
  });

  it("switches to schedule_sweeper (BYPASSRLS) for the cross-tenant poll and the claim transaction", async () => {
    // Regression test for a real bug: schedule_rules has RLS requiring
    // app.tenant_id, and this poll deliberately has no single tenant to
    // scope it to -- without SET LOCAL ROLE schedule_sweeper here, RLS
    // silently matches zero rows and no schedule rule ever fires (found via
    // manual QA; see 0107_schedule_sweeper_role.sql).
    const rule = makeRule();
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({ id: "ticket-1" });

    await schedulerTick();

    // Once for the poll transaction, once for claimRule's transaction.
    expect(mockSetScheduleSweeperRole).toHaveBeenCalledTimes(2);
  });

  it("skips a rule already claimed by another worker instance", async () => {
    const rule = makeRule();
    dueRules = [rule];
    claimRows = []; // simulates SELECT FOR UPDATE SKIP LOCKED finding nothing

    await schedulerTick();

    expect(mockCreateEntity).not.toHaveBeenCalled();
    expect(insertedExecutions).toHaveLength(0);
  });

  it("records a failed execution when createEntity throws, and continues the tick", async () => {
    const rule = makeRule();
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockRejectedValue(
      Object.assign(new Error("boom"), {
        name: "EntityError",
        code: "ENTITY_TYPE_NOT_FOUND",
      }),
    );

    await schedulerTick();

    expect(insertedExecutions).toHaveLength(1);
    expect(
      (insertedExecutions[0] as { status: string; errorCode?: string }).status,
    ).toBe("failed");
    expect((insertedExecutions[0] as { errorCode?: string }).errorCode).toBe(
      "ENTITY_TYPE_NOT_FOUND",
    );
    expect(mockScheduleExecutionAdd).toHaveBeenCalledWith(1, {
      status: "failed",
      errorCode: "ENTITY_TYPE_NOT_FOUND",
    });
  });

  it("catch_up: false skips all missed fires without creating any tickets", async () => {
    // originalScheduledAt far enough in the past to be classified overdue
    // (> 2x the 60s tick interval) and to produce missed fires via the
    // stubbed computeNextFireAt (1 hour per step).
    const rule = makeRule({
      nextFireAt: new Date(Date.now() - 3 * 3_600_000),
      catchUp: false,
    });
    dueRules = [rule];
    claimRows = [rule];

    await schedulerTick();

    expect(mockCreateEntity).not.toHaveBeenCalled();
    expect(
      insertedExecutions.every(
        (e) => (e as { status: string }).status === "skipped",
      ),
    ).toBe(true);
    expect(insertedExecutions.length).toBeGreaterThan(0);
    expect(mockScheduleCatchUpAdd).toHaveBeenCalledWith(1, {
      action: "skipped",
    });
  });

  it("catch_up: true executes missed fires up to the cap in chronological order", async () => {
    const rule = makeRule({
      nextFireAt: new Date(Date.now() - 3 * 3_600_000),
      catchUp: true,
    });
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({ id: "ticket-catchup" });

    await schedulerTick();

    expect(mockCreateEntity).toHaveBeenCalled();
    expect(mockScheduleCatchUpAdd).toHaveBeenCalledWith(1, {
      action: "executed",
    });
  });

  it("includes the fire that made the rule overdue as the FIRST catch-up fire, not just fires strictly after it", async () => {
    // Regression test: handleCatchUp's missed-fires enumeration must include
    // originalScheduledAt itself — it's the fire that made the rule overdue
    // in the first place, not merely a boundary marker for later fires.
    const originalScheduledAt = new Date(Date.now() - 3 * 3_600_000);
    const rule = makeRule({ nextFireAt: originalScheduledAt, catchUp: true });
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({ id: "ticket-catchup" });

    await schedulerTick();

    const scheduledAts = insertedExecutions.map((e) =>
      (e as { scheduledAt: Date }).scheduledAt.getTime(),
    );
    expect(scheduledAts).toContain(originalScheduledAt.getTime());
  });

  it("aggregates catch-up execution failures into the tick's failed count via schedule_execution_total", async () => {
    const rule = makeRule({
      nextFireAt: new Date(Date.now() - 3 * 3_600_000),
      catchUp: true,
    });
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockRejectedValue(
      Object.assign(new Error("boom"), {
        name: "EntityError",
        code: "ENTITY_TYPE_NOT_FOUND",
      }),
    );

    await schedulerTick();

    expect(mockScheduleExecutionAdd).toHaveBeenCalledWith(1, {
      status: "failed",
      errorCode: "ENTITY_TYPE_NOT_FOUND",
    });
    expect(
      insertedExecutions.some(
        (e) => (e as { status: string }).status === "failed",
      ),
    ).toBe(true);
  });

  it("catch_up: true executes the MOST RECENT CATCH_UP_MAX fires, not the earliest ones (Vijit review, G1)", async () => {
    // 30 hours of 1-hour-stepped backlog (via the stubbed computeNextFireAt)
    // produces ~30 missed fires, well over CATCH_UP_MAX (24) -- the cap must
    // keep the fires closest to `now`, dropping the oldest ones (including
    // originalScheduledAt itself here), not the reverse.
    const originalScheduledAt = new Date(Date.now() - 30 * 3_600_000);
    const rule = makeRule({ nextFireAt: originalScheduledAt, catchUp: true });
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({ id: "ticket-catchup" });

    await schedulerTick();

    expect(mockCreateEntity).toHaveBeenCalledTimes(24);
    const scheduledAts = insertedExecutions.map((e) =>
      (e as { scheduledAt: Date }).scheduledAt.getTime(),
    );
    expect(scheduledAts).not.toContain(originalScheduledAt.getTime());
    // The most recent missed fire (closest to `now`) must survive the cap.
    expect(Math.max(...scheduledAts)).toBeGreaterThan(
      originalScheduledAt.getTime() + 25 * 3_600_000,
    );
  });

  it("rejects a malformed stored template at fire time instead of reaching createEntity (Vijit review, G3)", async () => {
    // Empty title fails TemplateSchema's .min(1) -- simulates a template
    // row that predates a schema tightening, or was written outside the
    // API's own create/update validation path.
    const rule = makeRule({ template: { title: "" } });
    dueRules = [rule];
    claimRows = [rule];

    await schedulerTick();

    expect(mockCreateEntity).not.toHaveBeenCalled();
    expect(mockScheduleExecutionAdd).toHaveBeenCalledWith(1, {
      status: "failed",
      errorCode: "TEMPLATE_VALIDATION_FAILED",
    });
  });

  describe("mandate fields (docs/specs/schedule-rules-mandate-fields.md)", () => {
    // createEntity stores teamId in fields.team_id itself, so it survives on types with no
    // team_id field (docs/specs/mandatory-ticket-fields.md B4).
    it("teamId mode passes teamId (not assignedTo), leaving resolution to the entity.created -> resolve_oncall cascade", async () => {
      const rule = makeRule({
        template: {
          title: "Team review",
          teamId: "22222222-2222-2222-2222-222222222222",
          due_days: 1,
          remark: "r",
        },
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-team",
        workflowId: "wf-1",
        currentState: "open",
      });

      await schedulerTick();

      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      const createArgs = mockCreateEntity.mock.calls[0]?.[2] as {
        assignedTo?: string;
        teamId?: string;
        fields: Record<string, unknown>;
      };
      expect(createArgs.assignedTo).toBeUndefined();
      expect(createArgs.teamId).toBe("22222222-2222-2222-2222-222222222222");
    });

    // docs/specs/mandatory-ticket-fields.md R4: severity and remark go to their own columns.
    it("passes the remark and severity (default medium) as columns", async () => {
      const rule = makeRule({
        template: {
          title: "Columns",
          teamId: "22222222-2222-2222-2222-222222222222",
          due_days: 1,
          remark: "Weekly check",
        },
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-cols",
        workflowId: "wf-1",
        currentState: "open",
      });

      await schedulerTick();

      expect(mockCreateEntity.mock.calls[0]?.[2]).toMatchObject({
        remark: "Weekly check",
        severity: "medium",
      });
    });

    it("assignedTo mode passes assignedTo directly and writes no team_id field", async () => {
      const rule = makeRule({
        template: {
          title: "User review",
          assignedTo: "33333333-3333-3333-3333-333333333333",
          due_days: 1,
          remark: "r",
        },
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-user",
        workflowId: "wf-1",
        currentState: "open",
      });

      await schedulerTick();

      const createArgs = mockCreateEntity.mock.calls[0]?.[2] as {
        assignedTo?: string;
        fields: Record<string, unknown>;
      };
      expect(createArgs.assignedTo).toBe(
        "33333333-3333-3333-3333-333333333333",
      );
      expect(createArgs.fields["team_id"]).toBeUndefined();
    });

    // Owner decision 2026-10-16: counted from the ticket's creation, so a late catch-up run
    // still gets its full due_days instead of being created already past due.
    it("resolves due date as the ticket's creation time plus due_days days", async () => {
      const scheduledAt = new Date(Date.now() - 1000);
      const rule = makeRule({
        nextFireAt: scheduledAt,
        template: {
          title: "Due date check",
          teamId: "22222222-2222-2222-2222-222222222222",
          due_days: 3,
          remark: "r",
        },
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-due",
        workflowId: "wf-1",
        currentState: "open",
      });

      const before = Date.now();
      await schedulerTick();

      const createArgs = mockCreateEntity.mock.calls[0]?.[2] as {
        dueDate: string;
      };
      const due = new Date(createArgs.dueDate).getTime();
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      expect(due).toBeGreaterThanOrEqual(before + threeDays);
      expect(due).toBeLessThanOrEqual(Date.now() + threeDays);
    });

    it("posts the remark as the ticket's first comment, attributed to the rule's creator", async () => {
      const rule = makeRule({
        createdBy: "u-creator",
        template: {
          title: "Remark check",
          teamId: "22222222-2222-2222-2222-222222222222",
          due_days: 0,
          remark: "This is the remark text.",
        },
      });
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-remark",
        workflowId: "wf-1",
        currentState: "open",
      });

      await schedulerTick();

      expect(mockPostScheduleRemarkComment).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          instanceId: "ticket-remark",
          workflowId: "wf-1",
          currentState: "open",
          actorId: "u-creator",
          text: "This is the remark text.",
        }),
      );
    });

    it("does not post a remark when the created ticket has no workflow", async () => {
      const rule = makeRule();
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-no-wf",
        workflowId: null,
        currentState: "open",
      });

      await schedulerTick();

      expect(mockPostScheduleRemarkComment).not.toHaveBeenCalled();
    });

    it("a remark-post failure does not fail the fire — execution still records success", async () => {
      const rule = makeRule();
      dueRules = [rule];
      claimRows = [rule];
      mockCreateEntity.mockResolvedValue({
        id: "ticket-remark-fail",
        workflowId: "wf-1",
        currentState: "open",
      });
      mockPostScheduleRemarkComment.mockRejectedValue(new Error("boom"));

      await schedulerTick();

      expect(insertedExecutions).toHaveLength(1);
      expect((insertedExecutions[0] as { status: string }).status).toBe(
        "success",
      );
      expect(mockScheduleExecutionAdd).toHaveBeenCalledWith(1, {
        status: "success",
      });
    });

    it("skips rules for tenants that are inactive or have expired trials (#835)", async () => {
      const rule = makeRule({ tenantId: "tenant-expired" });
      dueRules = [rule];
      claimRows = [rule];
      mockIsTenantActive.mockResolvedValueOnce(false);

      await schedulerTick();

      expect(mockCreateEntity).not.toHaveBeenCalled();
      expect(insertedExecutions).toHaveLength(0);
    });

    it("counts rules of an ineligible tenant apart from missed fires skipped by catch-up (#996)", async () => {
      dueRules = [
        makeRule({ id: "rule-a", tenantId: "tenant-expired" }),
        makeRule({ id: "rule-b", tenantId: "tenant-expired" }),
      ];
      mockIsTenantActive.mockResolvedValue(false);
      vi.mocked(logger.info).mockClear();

      await schedulerTick();

      const summary = vi
        .mocked(logger.info)
        .mock.calls.find(
          ([, message]) => message === "scheduler tick complete",
        );
      expect(summary?.[0]).toMatchObject({
        totalDue: 2,
        success: 0,
        failed: 0,
        skipped: 0,
        skippedIneligible: 2,
      });
    });
  });
});
