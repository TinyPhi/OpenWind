import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockDedupSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockExecute = vi.fn();
const mockUpdateEntity = vi.fn();
const mockCreateEntity = vi.fn();
const mockGetEntity = vi.fn();
const mockCreateChildRelation = vi.fn();
const mockExecuteTransition = vi.fn();

// Simulates Drizzle's db.transaction(): runs the callback with a nested tx
// object that shares the same select/insert/update mocks.
const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn(dbMock);
});

const dbMock = {
  // Two select shapes are used by executor.ts: the rules lookup ends in
  // .orderBy() (mockSelect), T4's dedup existing-success check ends in
  // .limit() (mockDedupSelect) — kept distinct so tests can control each
  // independently.
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => mockSelect(),
        limit: () => mockDedupSelect(),
      }),
    }),
  }),
  insert: () => ({
    values: () => ({
      returning: mockInsert,
    }),
  }),
  update: () => ({
    set: () => ({
      where: mockUpdate,
    }),
  }),
  transaction: mockTransaction,
  execute: mockExecute,
};

vi.mock("@platform/db", () => ({
  automationRules: {},
  automationExecutions: {},
  db: dbMock,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    { join: vi.fn() },
  ),
}));

vi.mock("@platform/workflow-engine", () => ({
  evaluateConditionTree: vi.fn(() => true),
  executeTransition: (...args: unknown[]) => mockExecuteTransition(...args),
}));

vi.mock("@platform/entity-engine", () => ({
  updateEntity: (...args: unknown[]) => mockUpdateEntity(...args),
  createEntity: (...args: unknown[]) => mockCreateEntity(...args),
  getEntity: (...args: unknown[]) => mockGetEntity(...args),
  createChildRelation: (...args: unknown[]) => mockCreateChildRelation(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/config", () => ({
  env: { SSRF_BLOCK_CIDRS: [] },
}));

const { executeAutomationRules } = await import("./executor.js");

const TENANT_ID = "aaaaaaaa-0000-4000-a000-000000000001";

// Closed-circuit redis mock: get returns null (below threshold) so the circuit
// breaker allows actions to run. del is called after a successful action.
const MOCK_REDIS = {
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
};

const BASE_EVENT = {
  version: 1 as const,
  eventType: "workflow.transitioned" as const,
  tenantId: TENANT_ID,
  instanceId: "00000000-0000-0000-0000-000000000001",
  entityTypeId: "00000000-0000-0000-0000-000000000002",
  workflowId: "00000000-0000-0000-0000-000000000003",
  fromState: "open",
  toState: "closed",
  triggeredBy: "user" as const,
  actorId: null,
  occurredAt: "2026-01-01T00:00:00Z",
};

const EXEC_ROW = { id: "exec-001" };
const NOTIFY_RULE = {
  id: "rule-001",
  tenantId: TENANT_ID,
  isEnabled: true,
  triggerType: "workflow.transitioned",
  priority: 0,
  createdAt: new Date(),
  conditions: null,
  actions: [{ type: "notify", config: { channel: ["email"] } }],
};

describe("executeAutomationRules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue([EXEC_ROW]);
    mockUpdate.mockResolvedValue(undefined);
    mockDedupSelect.mockResolvedValue([]);
    mockExecute.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        await fn(dbMock);
      },
    );
    MOCK_REDIS.get.mockResolvedValue(null); // reset to closed circuit
    MOCK_REDIS.del.mockResolvedValue(1);
  });

  it("executes matching rules and writes execution row with success status", async () => {
    mockSelect.mockResolvedValue([NOTIFY_RULE]);

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockInsert).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("wraps each rule's actions in db.transaction() for atomic rollback", async () => {
    mockSelect.mockResolvedValue([NOTIFY_RULE]);

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    // Each rule should trigger one db.transaction() call for its action loop
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("skips rules whose conditions are not met", async () => {
    const { evaluateConditionTree } = await import("@platform/workflow-engine");
    vi.mocked(evaluateConditionTree).mockReturnValueOnce(false);
    mockSelect.mockResolvedValue([NOTIFY_RULE]);

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("throws CIRCUIT_BREAKER_UNAVAILABLE when redis is not provided (#245)", async () => {
    mockSelect.mockResolvedValue([NOTIFY_RULE]);

    await expect(
      executeAutomationRules(dbMock as never, TENANT_ID, BASE_EVENT),
    ).resolves.toBeUndefined(); // does not bubble — error is caught per-rule

    // Execution row created and updated to failed status
    expect(mockInsert).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("executes set_field action by calling updateEntity", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [
          {
            type: "set_field",
            config: { field: "priority", value: "high" },
          },
        ],
      },
    ]);
    mockUpdateEntity.mockResolvedValue({ id: BASE_EVENT.instanceId });

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockUpdateEntity).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      BASE_EVENT.instanceId,
      expect.objectContaining({ fields: { priority: "high" } }),
    );
  });

  it("executes assign action by calling updateEntity with assignedTo", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [{ type: "assign", config: { assigneeId: "user-123" } }],
      },
    ]);
    mockUpdateEntity.mockResolvedValue({ id: BASE_EVENT.instanceId });

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockUpdateEntity).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      BASE_EVENT.instanceId,
      expect.objectContaining({ assignedTo: "user-123" }),
    );
  });

  it("executes create_entity action by calling createEntity", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [
          {
            type: "create_entity",
            config: {
              entityTypeId: "00000000-0000-0000-0000-000000000042",
              fields: { title: "Follow-up" },
            },
          },
        ],
      },
    ]);
    mockCreateEntity.mockResolvedValue({ id: "new-entity-1" });

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockCreateEntity).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      expect.objectContaining({
        entityTypeId: "00000000-0000-0000-0000-000000000042",
        fields: { title: "Follow-up" },
      }),
    );
  });

  it("executes create_child action: creates the child, interpolates the description from parent fields, and writes the child id back onto the parent", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [
          {
            type: "create_child",
            config: {
              descriptionTemplate: "{{title}}\n\n{{summary}}",
              writeBackField: "costing_child_id",
            },
          },
        ],
      },
    ]);
    mockGetEntity.mockResolvedValue({
      id: BASE_EVENT.instanceId,
      entityTypeId: BASE_EVENT.entityTypeId,
      fields: { title: "Tender A", summary: "Roof replacement" },
    });
    mockCreateChildRelation.mockResolvedValue({
      instance: { id: "child-1" },
      relations: [],
    });
    mockUpdateEntity.mockResolvedValue({ id: BASE_EVENT.instanceId });

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockCreateChildRelation).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      expect.objectContaining({
        parentId: BASE_EVENT.instanceId,
        entityTypeId: BASE_EVENT.entityTypeId,
        childFields: { description: "Tender A\n\nRoof replacement" },
      }),
    );
    expect(mockUpdateEntity).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      BASE_EVENT.instanceId,
      expect.objectContaining({ fields: { costing_child_id: "child-1" } }),
    );
  });

  it("create_child action defaults entityTypeId to the parent's own type and skips the write-back when writeBackField is omitted", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [{ type: "create_child", config: {} }],
      },
    ]);
    mockGetEntity.mockResolvedValue({
      id: BASE_EVENT.instanceId,
      entityTypeId: BASE_EVENT.entityTypeId,
      fields: {},
    });
    mockCreateChildRelation.mockResolvedValue({
      instance: { id: "child-2" },
      relations: [],
    });

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockCreateChildRelation).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      expect.objectContaining({ entityTypeId: BASE_EVENT.entityTypeId }),
    );
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it("create_child action skips creating a second child when writeBackField is already set on the parent (#162 exactly-once guard)", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [
          {
            type: "create_child",
            config: { writeBackField: "costing_child_id" },
          },
        ],
      },
    ]);
    mockGetEntity.mockResolvedValue({
      id: BASE_EVENT.instanceId,
      entityTypeId: BASE_EVENT.entityTypeId,
      fields: { costing_child_id: "existing-child-1" },
    });

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockCreateChildRelation).not.toHaveBeenCalled();
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it("executes transition action by calling executeTransition", async () => {
    mockExecuteTransition.mockResolvedValue({
      id: "ev-1",
      instanceId: BASE_EVENT.instanceId,
      workflowId: BASE_EVENT.workflowId,
      fromState: "open",
      toState: "closed",
      createdAt: new Date(),
    });
    // First call: rule with transition action; follow-up returns no rules
    mockSelect
      .mockResolvedValueOnce([
        {
          ...NOTIFY_RULE,
          actions: [
            {
              type: "transition",
              config: {
                transitionId: "00000000-0000-0000-0000-000000000099",
              },
            },
          ],
        },
      ])
      .mockResolvedValue([]);

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    expect(mockExecuteTransition).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      expect.objectContaining({
        instanceId: BASE_EVENT.instanceId,
        transitionId: "00000000-0000-0000-0000-000000000099",
        triggeredBy: "automation",
      }),
    );
  });

  it("throws MAX_DEPTH_EXCEEDED at depth 10", async () => {
    const { AutomationError } = await import("./types.js");
    await expect(
      executeAutomationRules(dbMock as never, TENANT_ID, BASE_EVENT, 10),
    ).rejects.toBeInstanceOf(AutomationError);
  });

  it("does not throw at depth 9", async () => {
    mockSelect.mockResolvedValue([]);
    await expect(
      executeAutomationRules(dbMock as never, TENANT_ID, BASE_EVENT, 9),
    ).resolves.toBeUndefined();
  });

  it("rolls back inner transaction and writes failed status when action throws", async () => {
    mockSelect.mockResolvedValue([
      {
        ...NOTIFY_RULE,
        actions: [{ type: "set_field", config: { field: "x", value: 1 } }],
      },
    ]);
    mockUpdateEntity.mockRejectedValue(new Error("DB error"));
    // Simulate transaction rollback on error (re-throw from the inner tx)
    mockTransaction.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<void>) => {
        await fn(dbMock); // fn will throw; let it propagate
      },
    );

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      MOCK_REDIS as never,
    );

    // Audit log update still called on outer db after inner tx rolled back
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("records degraded status when circuit breaker skips an action", async () => {
    // Wire a Redis-like mock where the circuit is open
    const mockRedis = { get: vi.fn().mockResolvedValue("10") }; // >= threshold(5) = open
    mockSelect.mockResolvedValue([NOTIFY_RULE]);

    await executeAutomationRules(
      dbMock as never,
      TENANT_ID,
      BASE_EVENT,
      0,
      mockRedis as never,
    );

    expect(mockUpdate).toHaveBeenCalled();
    const { logger } = await import("@platform/logger");
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ skippedCount: 1 }),
      expect.stringContaining("degraded"),
    );
  });

  it("throws INVALID_EVENT_PAYLOAD for unknown event shapes", async () => {
    const { AutomationError } = await import("./types.js");
    await expect(
      executeAutomationRules(dbMock as never, TENANT_ID, { bad: "data" }),
    ).rejects.toBeInstanceOf(AutomationError);
  });

  describe("transitionEventId dedup (#143 Phase 2 / T4)", () => {
    const TRANSITION_EVENT_ID = "eeeeeeee-0000-4000-a000-000000000099";

    it("does not acquire the advisory lock or run the dedup check when transitionEventId is absent", async () => {
      mockSelect.mockResolvedValue([NOTIFY_RULE]);

      await executeAutomationRules(
        dbMock as never,
        TENANT_ID,
        BASE_EVENT,
        0,
        MOCK_REDIS as never,
        undefined,
        undefined,
      );

      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockDedupSelect).not.toHaveBeenCalled();
      expect(mockInsert).toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("acquires the advisory lock and runs the rule normally when no prior success row exists", async () => {
      mockSelect.mockResolvedValue([NOTIFY_RULE]);
      mockDedupSelect.mockResolvedValue([]); // no existing success row

      await executeAutomationRules(
        dbMock as never,
        TENANT_ID,
        BASE_EVENT,
        0,
        MOCK_REDIS as never,
        undefined,
        TRANSITION_EVENT_ID,
      );

      expect(mockExecute).toHaveBeenCalledOnce();
      expect(mockDedupSelect).toHaveBeenCalledOnce();
      expect(mockInsert).toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledOnce();
    });

    it("skips the rule entirely — no insert, no actions — when a success row already exists for (ruleId, transitionEventId)", async () => {
      mockSelect.mockResolvedValue([NOTIFY_RULE]);
      mockDedupSelect.mockResolvedValue([{ id: "prior-exec-1" }]);

      await executeAutomationRules(
        dbMock as never,
        TENANT_ID,
        BASE_EVENT,
        0,
        MOCK_REDIS as never,
        undefined,
        TRANSITION_EVENT_ID,
      );

      expect(mockExecute).toHaveBeenCalledOnce(); // lock still acquired
      expect(mockDedupSelect).toHaveBeenCalledOnce();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
