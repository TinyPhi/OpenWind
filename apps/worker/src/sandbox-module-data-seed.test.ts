/**
 * sandbox-module-data-seed.test.ts
 *
 * Unit tests for seedAllModulesData (docs/specs/multi-org-sandbox.md T9). DB,
 * entity-engine, and workflow-engine are all mocked at the service/package boundary
 * (testing-conventions.md) -- this is not an isolation test against a real Postgres
 * instance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const entityTypesTable = Symbol("entityTypes");
const workflowsTable = Symbol("workflows");
const entityFieldsTable = Symbol("entityFields");
const workflowTransitionsTable = Symbol("workflowTransitions");
const outboxEventsTable = Symbol("outboxEvents");

const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

// Query results, keyed by which table .from() was called with -- set per test.
let entityFieldRows: unknown[] = [];
let transitionRows: unknown[] = [];

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  entityTypes: entityTypesTable,
  workflows: workflowsTable,
  entityFields: entityFieldsTable,
  workflowTransitions: workflowTransitionsTable,
  outboxEvents: outboxEventsTable,
}));

const mockCreateEntity = vi.fn();
vi.mock("@platform/entity-engine", () => ({
  createEntity: (...args: unknown[]) => mockCreateEntity(...args),
}));

const mockExecuteTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/workflow-engine", () => ({
  executeTransition: (...args: unknown[]) => mockExecuteTransition(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { seedAllModulesData } = await import("./sandbox-module-data-seed.js");

beforeEach(() => {
  vi.clearAllMocks();

  mockFrom.mockImplementation((table: unknown) => {
    if (table === workflowTransitionsTable) {
      // workflowTransitions is selected without a further .limit() -- awaited directly.
      return {
        where: (..._args: unknown[]) => Promise.resolve(transitionRows),
      };
    }
    return { where: mockWhere };
  });

  mockWhere.mockImplementation(() => ({
    limit: mockLimit,
  }));

  // entityTypes -> workflows -> entityFields is the call order in seedModuleData;
  // mockLimit is shared, so queue results per call via mockImplementationOnce chains
  // set per test instead of a fixed default here.
  mockCreateEntity.mockImplementation(
    async (
      _db: unknown,
      _tenantId: string,
      input: { fields: Record<string, unknown> },
    ) => ({
      id: `entity-${Math.random()}`,
      currentState: "initial-state",
      fields: input.fields,
    }),
  );
});

function queueEntityTypeAndWorkflowAndFields(): void {
  mockLimit
    .mockResolvedValueOnce([{ id: "entity-type-1" }]) // entityTypes lookup
    .mockResolvedValueOnce([{ id: "workflow-1" }]); // workflows lookup
}

describe("seedAllModulesData", () => {
  it("seeds one record per recordPath entry for a known module, with required fields filled", async () => {
    queueEntityTypeAndWorkflowAndFields();
    entityFieldRows = [{ name: "title", fieldType: "text", config: {} }];
    mockWhere.mockImplementationOnce(() => ({ limit: mockLimit })); // entityTypes where
    mockWhere.mockImplementationOnce(() => ({ limit: mockLimit })); // workflows where
    mockWhere.mockImplementationOnce(() => Promise.resolve(entityFieldRows)); // entityFields where (awaited directly)
    transitionRows = [
      { id: "t-1", fromState: "backlog", toState: "todo" },
      { id: "t-2", fromState: "todo", toState: "in_progress" },
      { id: "t-3", fromState: "in_progress", toState: "in_review" },
      { id: "t-4", fromState: "in_review", toState: "done" },
    ];

    await seedAllModulesData("tenant-1", ["projects"]);

    // projects has 5 recordPaths (backlog, todo, in_progress, in_review, done).
    expect(mockCreateEntity).toHaveBeenCalledTimes(5);
    expect(mockCreateEntity).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({
        entityTypeId: "entity-type-1",
        workflowId: "workflow-1",
        actorId: "system",
        actorType: "system",
        fields: expect.objectContaining({ title: expect.any(String) }),
      }),
    );
  });

  it("drives each record through the right number of real transitions for its target state", async () => {
    queueEntityTypeAndWorkflowAndFields();
    mockWhere.mockImplementationOnce(() => ({ limit: mockLimit }));
    mockWhere.mockImplementationOnce(() => ({ limit: mockLimit }));
    mockWhere.mockImplementationOnce(() => Promise.resolve([]));
    transitionRows = [
      { id: "t-1", fromState: "backlog", toState: "todo" },
      { id: "t-2", fromState: "todo", toState: "in_progress" },
      { id: "t-3", fromState: "in_progress", toState: "in_review" },
      { id: "t-4", fromState: "in_review", toState: "done" },
    ];
    mockCreateEntity.mockImplementation(async () => ({
      id: "entity-x",
      currentState: "backlog",
      fields: {},
    }));

    await seedAllModulesData("tenant-1", ["projects"]);

    // projects' longest path (backlog -> todo -> in_progress -> in_review -> done) is 4 hops.
    const doneCall = mockExecuteTransition.mock.calls.find(
      (call) => call[2]?.transitionId === "t-4",
    );
    expect(doneCall).toBeDefined();
    expect(mockExecuteTransition).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({
        instanceId: "entity-x",
        actorId: "system",
        actorRoles: expect.arrayContaining(["admin", "agent", "user"]),
        triggeredBy: "system",
      }),
    );
  });

  it("skips a module slug with no seed plan without throwing", async () => {
    await expect(
      seedAllModulesData("tenant-1", ["not-a-real-module"]),
    ).resolves.toBeUndefined();
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("continues with remaining modules when one module's seeding throws", async () => {
    mockLimit.mockRejectedValueOnce(new Error("db exploded"));

    await expect(
      seedAllModulesData("tenant-1", ["helpdesk", "not-a-real-module"]),
    ).resolves.toBeUndefined();
  });

  it("marks outbox rows produced during seeding as delivered, to suppress automation side-effects", async () => {
    await seedAllModulesData("tenant-1", []);

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveredAt: expect.any(Date),
        notifiedDeliveredAt: expect.any(Date),
      }),
    );
  });
});
