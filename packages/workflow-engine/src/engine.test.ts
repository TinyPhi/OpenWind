import { describe, it, expect, vi, beforeEach } from "vitest";
// ── DB mock helpers ───────────────────────────────────────────────────────────

function makeSelectBuilder(results: () => unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["orderBy"] = () => q;
  q["limit"] = () => q;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(results()).then(resolve);
  return q;
}

const mockInsertValues = vi.fn(() => ({
  returning: vi.fn().mockResolvedValue([fakeEvent]),
}));
const mockUpdate = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn().mockResolvedValue([]),
  })),
}));

let selectCallCount = 0;
let selectResults: (() => unknown[])[] = [];

const dbMock = {
  select: vi.fn(() => {
    const result = selectResults[selectCallCount] ?? (() => []);
    selectCallCount++;
    return makeSelectBuilder(result);
  }),
  insert: vi.fn((table: unknown) => {
    if (table === "outbox_events_mock") {
      return { values: vi.fn().mockResolvedValue([]) };
    }
    return { values: mockInsertValues };
  }),
  update: mockUpdate,
};

vi.mock("@platform/db", () => ({
  entityInstances: "entity_instances_mock",
  workflows: "workflows_mock",
  workflowTransitions: "workflow_transitions_mock",
  workflowStates: "workflow_states_mock",
  workflowEvents: "workflow_events_mock",
  outboxEvents: "outbox_events_mock",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-111";
const INSTANCE_ID = "instance-222";
const WORKFLOW_ID = "workflow-333";
const TRANSITION_ID = "transition-444";

const fakeInstance = {
  id: INSTANCE_ID,
  entityTypeId: "type-aaa",
  tenantId: TENANT_ID,
  workflowId: WORKFLOW_ID,
  currentState: "open",
  fields: { subject: "Bug report", priority: "high" },
  createdBy: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeWorkflow = {
  id: WORKFLOW_ID,
  tenantId: null,
  entityTypeId: "type-aaa",
  name: "Ticket Workflow",
  initialState: "open",
  createdAt: new Date(),
};

const fakeTransition = {
  id: TRANSITION_ID,
  workflowId: WORKFLOW_ID,
  fromState: "open",
  toState: "in_progress",
  label: "Start Working",
  allowedRoles: [],
  conditions: null,
  requiresComment: false,
  requiresFields: [],
};

const fakeEvent = {
  id: "event-555",
  instanceId: INSTANCE_ID,
  workflowId: WORKFLOW_ID,
  fromState: "open",
  toState: "in_progress",
  triggeredBy: "user",
  actorId: "user-aaa",
  comment: null,
  metadata: {},
  createdAt: new Date(),
};

// ── Import engine after mocks ─────────────────────────────────────────────────

const { executeTransition, getAvailableTransitions, getWorkflowEventLog } =
  await import("./engine.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
    mockInsertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([fakeEvent]),
    });
    dbMock.insert.mockImplementation((table) => {
      if (table === "outbox_events_mock")
        return { values: vi.fn().mockResolvedValue([]) };
      if (table === "workflow_events_mock") return { values: mockInsertValues };
      return { values: vi.fn().mockResolvedValue([]) };
    });
  });

  it("executes a valid transition and returns a workflow event", async () => {
    // Selects: instance, workflow, transition, workflowState
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [fakeTransition],
      () => [], // no SLA state
    ];

    const event = await executeTransition(dbMock as never, TENANT_ID, {
      instanceId: INSTANCE_ID,
      transitionId: TRANSITION_ID,
      actorId: "user-aaa",
      triggeredBy: "user",
    });

    expect(event.fromState).toBe("open");
    expect(event.toState).toBe("in_progress");
    expect(event.triggeredBy).toBe("user");
  });

  it("throws INSTANCE_NOT_FOUND when instance does not exist", async () => {
    selectResults = [() => []];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: "nonexistent",
        transitionId: TRANSITION_ID,
      }),
    ).rejects.toMatchObject({ code: "INSTANCE_NOT_FOUND" });
  });

  it("throws INSTANCE_NOT_FOUND when instance has no workflow attached", async () => {
    selectResults = [() => [{ ...fakeInstance, workflowId: null }]];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
      }),
    ).rejects.toMatchObject({ code: "INSTANCE_NOT_FOUND" });
  });

  it("throws TRANSITION_NOT_AVAILABLE when transition is not found", async () => {
    selectResults = [() => [fakeInstance], () => [fakeWorkflow], () => []];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: "nonexistent-transition",
      }),
    ).rejects.toMatchObject({ code: "TRANSITION_NOT_AVAILABLE" });
  });

  it("throws TRANSITION_NOT_AVAILABLE when fromState does not match current state", async () => {
    const wrongTransition = { ...fakeTransition, fromState: "closed" };
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [wrongTransition],
    ];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
      }),
    ).rejects.toMatchObject({ code: "TRANSITION_NOT_AVAILABLE" });
  });

  it("throws TRANSITION_FORBIDDEN when actor lacks required role", async () => {
    const restrictedTransition = {
      ...fakeTransition,
      allowedRoles: ["manager", "admin"],
    };
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [restrictedTransition],
    ];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
        actorRoles: ["agent"],
      }),
    ).rejects.toMatchObject({ code: "TRANSITION_FORBIDDEN" });
  });

  it("allows transition when actor has one of the allowed roles", async () => {
    const restrictedTransition = {
      ...fakeTransition,
      allowedRoles: ["manager", "admin"],
    };
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [restrictedTransition],
      () => [],
    ];

    const event = await executeTransition(dbMock as never, TENANT_ID, {
      instanceId: INSTANCE_ID,
      transitionId: TRANSITION_ID,
      actorRoles: ["manager"],
    });
    expect(event.toState).toBe("in_progress");
  });

  it("throws CONDITION_NOT_MET when condition evaluates false", async () => {
    const conditionalTransition = {
      ...fakeTransition,
      conditions: { op: "eq", field: "priority", value: "low" },
    };
    selectResults = [
      () => [fakeInstance], // fields.priority = "high"
      () => [fakeWorkflow],
      () => [conditionalTransition],
    ];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
      }),
    ).rejects.toMatchObject({ code: "CONDITION_NOT_MET" });
  });

  it("throws REQUIRED_FIELDS_MISSING when a required field is empty", async () => {
    const requiresFieldsTransition = {
      ...fakeTransition,
      requiresFields: ["resolution"],
    };
    selectResults = [
      () => [fakeInstance], // fields has no "resolution"
      () => [fakeWorkflow],
      () => [requiresFieldsTransition],
    ];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
      }),
    ).rejects.toMatchObject({ code: "REQUIRED_FIELDS_MISSING" });
  });

  it("throws REQUIRED_FIELDS_MISSING when comment is required but not provided", async () => {
    const requiresCommentTransition = {
      ...fakeTransition,
      requiresComment: true,
    };
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [requiresCommentTransition],
    ];

    await expect(
      executeTransition(dbMock as never, TENANT_ID, {
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
      }),
    ).rejects.toMatchObject({ code: "REQUIRED_FIELDS_MISSING" });
  });

  it("succeeds when comment is required and provided", async () => {
    const requiresCommentTransition = {
      ...fakeTransition,
      requiresComment: true,
    };
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [requiresCommentTransition],
      () => [],
    ];

    const event = await executeTransition(dbMock as never, TENANT_ID, {
      instanceId: INSTANCE_ID,
      transitionId: TRANSITION_ID,
      comment: "Picking this up now",
    });
    expect(event.toState).toBe("in_progress");
  });

  it("writes immutable event log entry on successful transition", async () => {
    selectResults = [
      () => [fakeInstance],
      () => [fakeWorkflow],
      () => [fakeTransition],
      () => [],
    ];

    await executeTransition(dbMock as never, TENANT_ID, {
      instanceId: INSTANCE_ID,
      transitionId: TRANSITION_ID,
    });

    // workflowEvents insert was called
    expect(mockInsertValues).toHaveBeenCalled();
  });
});

describe("getAvailableTransitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
  });

  it("returns transitions available for current state and actor roles", async () => {
    const t1 = {
      ...fakeTransition,
      id: "t1",
      allowedRoles: [],
      conditions: null,
    };
    const t2 = {
      ...fakeTransition,
      id: "t2",
      fromState: "open",
      toState: "escalated",
      allowedRoles: ["manager"],
      conditions: null,
    };
    selectResults = [() => [fakeInstance], () => [t1, t2]];

    const result = await getAvailableTransitions(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
      ["agent"],
    );
    // t1 is open to all roles; t2 requires manager
    expect(result.map((t) => t.id)).toContain("t1");
    expect(result.map((t) => t.id)).not.toContain("t2");
  });

  it("returns empty array when instance not found", async () => {
    selectResults = [() => []];
    const result = await getAvailableTransitions(
      dbMock as never,
      TENANT_ID,
      "missing",
      [],
    );
    expect(result).toEqual([]);
  });

  it("filters out transitions whose conditions are not met", async () => {
    const t = {
      ...fakeTransition,
      allowedRoles: [],
      conditions: { op: "eq", field: "priority", value: "low" }, // instance has priority=high
    };
    selectResults = [() => [fakeInstance], () => [t]];

    const result = await getAvailableTransitions(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
      [],
    );
    expect(result).toHaveLength(0);
  });
});

describe("getWorkflowEventLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
  });

  it("returns ordered events for a valid instance", async () => {
    selectResults = [() => [{ id: INSTANCE_ID }], () => [fakeEvent]];

    const events = await getWorkflowEventLog(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.toState).toBe("in_progress");
  });

  it("returns empty array when instance not found", async () => {
    selectResults = [() => []];
    const events = await getWorkflowEventLog(
      dbMock as never,
      TENANT_ID,
      "missing",
    );
    expect(events).toEqual([]);
  });
});
