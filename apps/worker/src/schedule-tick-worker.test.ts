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
vi.mock("@platform/telemetry", () => ({
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
  assignee_id: z.string().uuid().optional(),
  team_id: z.string().uuid().optional(),
  service_id: z.string().uuid().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
vi.mock("@platform/scheduler", () => ({
  computeNextFireAt: (...args: [string, string, Date]) =>
    mockComputeNextFireAt(...args),
  buildTemplateVariables: () => ({}),
  renderTemplate: (template: unknown) => template,
  TemplateSchema: mockTemplateSchema,
  validateScheduleRuleRefs: (...args: unknown[]) =>
    mockValidateScheduleRuleRefs(...args),
}));

let dueRules: unknown[] = [];
let claimRows: unknown[] = [];

const insertedExecutions: unknown[] = [];

const withTenantTx = {
  insert: (_table: unknown) => ({
    values: (values: unknown) => {
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
const pollTx = {
  select: () => ({
    from: () => ({
      where: () => Promise.resolve(dueRules),
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

vi.mock("@platform/db", () => ({
  db: {
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn(transactionCallCount++ === 0 ? pollTx : claimTx),
  },
  withTenantContext: (...args: [string, (tx: unknown) => Promise<unknown>]) =>
    mockWithTenantContext(...args),
  setScheduleSweeperRole: (...args: unknown[]) =>
    mockSetScheduleSweeperRole(...args),
  scheduleRules: "schedule_rules_table",
  scheduleExecutions: "schedule_executions_table",
  workflowEvents: "workflow_events_table",
}));

const { schedulerTick } = await import("./schedule-tick-worker.js");

function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rule-1",
    tenantId: "tenant-1",
    name: "Weekly review",
    cronExpr: "0 9 * * 1",
    timezone: "UTC",
    entityTypeId: "et-1",
    workflowId: null,
    template: { title: "Weekly review" },
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
    transactionCallCount = 0;
    mockWriteAuditEntry.mockClear();
    mockScheduleTickAdd.mockClear();
    mockScheduleExecutionAdd.mockClear();
    mockScheduleCatchUpAdd.mockClear();
    mockCreateEntity.mockReset();
    mockValidateScheduleRuleRefs.mockReset().mockResolvedValue([]);
    mockWithTenantContext.mockClear();
    mockSetScheduleSweeperRole.mockClear();
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

  it("posts the template's remark as the ticket's first comment, authored by the rule owner", async () => {
    // User request: the schedule rule's "remark" (template.description)
    // shows up as the first comment on the auto-created ticket, attributed
    // to whoever created the rule -- not a silent system actor.
    const rule = makeRule({
      createdBy: "u-creator",
      template: { title: "Weekly review", description: "Please review Q3." },
    });
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({
      id: "ticket-1",
      workflowId: "wf-1",
      currentState: "open",
    });

    await schedulerTick();

    const commentEvent = insertedExecutions.find(
      (e) =>
        (e as { metadata?: { type?: string } }).metadata?.type === "comment",
    ) as
      | {
          instanceId: string;
          workflowId: string;
          actorId: string;
          triggeredBy: string;
          metadata: { type: string; text: string };
        }
      | undefined;

    expect(commentEvent).toBeDefined();
    expect(commentEvent?.instanceId).toBe("ticket-1");
    expect(commentEvent?.workflowId).toBe("wf-1");
    expect(commentEvent?.actorId).toBe("u-creator");
    expect(commentEvent?.triggeredBy).toBe("user");
    expect(commentEvent?.metadata.text).toBe("Please review Q3.");
  });

  it("does not post a comment when the template has no remark", async () => {
    const rule = makeRule({ template: { title: "Weekly review" } });
    dueRules = [rule];
    claimRows = [rule];
    mockCreateEntity.mockResolvedValue({
      id: "ticket-1",
      workflowId: "wf-1",
      currentState: "open",
    });

    await schedulerTick();

    const commentEvent = insertedExecutions.find(
      (e) =>
        (e as { metadata?: { type?: string } }).metadata?.type === "comment",
    );
    expect(commentEvent).toBeUndefined();
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
});
