import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// ── DB mock helpers ───────────────────────────────────────────────────────────
// Same mocking style as engine.test.ts: @platform/db and drizzle-orm are
// module-mocked (not a real connection), matching this package's existing
// convention rather than introducing a new real-DB harness for one suite.

let selectCallCount = 0;
let selectQueue: (() => unknown[])[] = [];

function makeSelectBuilder(results: () => unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["orderBy"] = () => q;
  q["limit"] = () => q;
  q["offset"] = () => Promise.resolve(results());
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(results()).then(resolve);
  return q;
}

type UpdateCall = {
  table: unknown;
  setVals: Record<string, unknown>;
  whereArgs: unknown;
};
let updateCalls: UpdateCall[] = [];

const mockUpdate = vi.fn((table: unknown) => ({
  set: vi.fn((setVals: Record<string, unknown>) => ({
    where: vi.fn((whereArgs: unknown) => {
      updateCalls.push({ table, setVals, whereArgs });
      let returnRow: unknown;
      if (table === "workflow_states_mock") returnRow = updatedStateRow;
      else if (table === "workflows_mock")
        returnRow = { ...workflowRow, ...setVals };
      return {
        returning: vi
          .fn()
          .mockResolvedValue(returnRow === undefined ? [] : [returnRow]),
      };
    }),
  })),
}));

type InsertCall = { table: unknown; values: Record<string, unknown> };
let insertCalls: InsertCall[] = [];
let insertReturnRow: unknown = undefined;

const mockInsert = vi.fn((table: unknown) => ({
  values: vi.fn((values: Record<string, unknown>) => {
    insertCalls.push({ table, values });
    return {
      returning: vi
        .fn()
        .mockResolvedValue(
          insertReturnRow === undefined ? [] : [insertReturnRow],
        ),
      onConflictDoNothing: vi.fn(() => ({
        returning: vi
          .fn()
          .mockResolvedValue(
            insertReturnRow === undefined ? [] : [insertReturnRow],
          ),
      })),
    };
  }),
}));

const dbMock = {
  select: vi.fn(() => {
    const result = selectQueue[selectCallCount] ?? (() => []);
    selectCallCount++;
    return makeSelectBuilder(result);
  }),
  update: mockUpdate,
  insert: mockInsert,
};

vi.mock("@platform/db", () => ({
  workflows: "workflows_mock",
  workflowStates: "workflow_states_mock",
  workflowTransitions: "workflow_transitions_mock",
  entityInstances: "entity_instances_mock",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
  count: vi.fn(() => ({ op: "count" })),
  sql: vi.fn((..._args: unknown[]) => ({ op: "sql" })),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./authorization.js", () => ({
  isWorkflowAdmin: vi.fn(() => true),
  isWorkflowAdminListEditor: vi.fn(() => true),
}));

const {
  updateWorkflowState,
  listWorkflows,
  listWorkflowsSummary,
  getWorkflowByEntityTypeId,
  addWorkflowState,
  updateWorkflow,
} = await import("./workflow-crud.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-111";
const WORKFLOW_ID = "workflow-333";
const STATE_ID = "state-555";
const CALLER = { userId: "user-999", isGlobalAdmin: true };

const currentStateRow = {
  id: STATE_ID,
  workflowId: WORKFLOW_ID,
  name: "open",
  label: "Open",
  color: "#888",
  isTerminal: false,
  slaHours: null,
  sortOrder: 0,
};

const updatedStateRow = {
  ...currentStateRow,
  name: "in_progress",
  label: "In Progress",
};

// assertWorkflowOwned's select (returns the workflow row) is the first select
// call inside every workflow-crud function.
const ownedWorkflowRow = {
  id: WORKFLOW_ID,
  createdBy: CALLER.userId,
  assignedTo: [CALLER.userId],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectCallCount = 0;
  selectQueue = [];
  updateCalls = [];
  insertCalls = [];
  insertReturnRow = undefined;
});

const workflowRow = {
  id: WORKFLOW_ID,
  tenantId: TENANT_ID,
  entityTypeId: "etype-1",
  name: "Support",
  initialState: "open",
  isActive: true,
  createdBy: CALLER.userId,
  assignedTo: [CALLER.userId],
  maxChildDepth: 1,
  maxChildrenPerParent: null,
  createdAt: new Date("2026-01-01"),
};

describe("listWorkflowsSummary — limit parameter (#261)", () => {
  it("returns mapped workflow rows from the DB", async () => {
    selectQueue = [() => [workflowRow]];

    const results = await listWorkflowsSummary(
      dbMock as never,
      TENANT_ID,
      CALLER,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(WORKFLOW_ID);
    expect(results[0]?.name).toBe("Support");
  });

  it("returns empty array when no workflows match", async () => {
    selectQueue = [() => []];

    const results = await listWorkflowsSummary(
      dbMock as never,
      TENANT_ID,
      CALLER,
      undefined,
      false,
      10,
    );

    expect(results).toHaveLength(0);
  });
});

describe("updateWorkflow — allowAutoGrantOnMention (ADR-012 Phase C, spec R5)", () => {
  it("writes allowAutoGrantOnMention when provided", async () => {
    selectQueue = [() => [workflowRow]]; // load + ownership check

    await updateWorkflow(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
      allowAutoGrantOnMention: true,
    });

    const call = updateCalls.find((c) => c.table === "workflows_mock");
    expect(call?.setVals.allowAutoGrantOnMention).toBe(true);
  });

  it("leaves allowAutoGrantOnMention untouched when not provided", async () => {
    selectQueue = [() => [workflowRow]];

    await updateWorkflow(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
      isActive: false,
    });

    const call = updateCalls.find((c) => c.table === "workflows_mock");
    expect(call?.setVals.allowAutoGrantOnMention).toBeUndefined();
  });
});

describe("updateWorkflowState — rename cascade", () => {
  it("cascades a rename into transitions, initialState, and entity_instances.currentState", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // assertWorkflowOwned
      () => [currentStateRow], // load current state
      () => [], // duplicate-name check — no conflict
    ];

    const result = await updateWorkflowState(
      dbMock as never,
      TENANT_ID,
      WORKFLOW_ID,
      STATE_ID,
      CALLER,
      { name: "in_progress", label: "In Progress" },
    );

    expect(result.name).toBe("in_progress");

    // One cascade update per: workflow_transitions.fromState,
    // workflow_transitions.toState, workflows.initialState,
    // entity_instances.currentState — plus the workflow_states row update
    // itself = 5 update() calls total.
    expect(updateCalls).toHaveLength(5);

    const entityInstanceUpdate = updateCalls.find(
      (c) => c.table === "entity_instances_mock",
    );
    expect(entityInstanceUpdate).toBeDefined();
    expect(entityInstanceUpdate?.setVals).toEqual({
      currentState: "in_progress",
    });

    const transitionUpdates = updateCalls.filter(
      (c) => c.table === "workflow_transitions_mock",
    );
    expect(transitionUpdates).toHaveLength(2);
    expect(transitionUpdates[0]?.setVals).toEqual({ fromState: "in_progress" });
    expect(transitionUpdates[1]?.setVals).toEqual({ toState: "in_progress" });

    const workflowUpdate = updateCalls.find(
      (c) => c.table === "workflows_mock",
    );
    expect(workflowUpdate?.setVals).toEqual({ initialState: "in_progress" });
  });

  it("does not touch transitions/initialState/entity_instances when label changes without a rename", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // assertWorkflowOwned
      () => [currentStateRow], // load current state
    ];

    await updateWorkflowState(
      dbMock as never,
      TENANT_ID,
      WORKFLOW_ID,
      STATE_ID,
      CALLER,
      { label: "Renamed Label Only" },
    );

    // Only the workflow_states row itself is updated — no cascade.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.table).toBe("workflow_states_mock");
  });

  it("throws WORKFLOW_STATE_NAME_TAKEN when another step already uses the requested name", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // assertWorkflowOwned
      () => [currentStateRow], // load current state
      () => [{ id: "some-other-state" }], // duplicate-name check — conflict
    ];

    await expect(
      updateWorkflowState(
        dbMock as never,
        TENANT_ID,
        WORKFLOW_ID,
        STATE_ID,
        CALLER,
        { name: "resolved" },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_STATE_NAME_TAKEN" });

    // No writes should happen once the duplicate check fails.
    expect(updateCalls).toHaveLength(0);
  });
});

describe("listWorkflows / listWorkflowsSummary — tenant-wide visibility", () => {
  const NON_ADMIN_CALLER = { userId: "user-222", isGlobalAdmin: false };

  it("listWorkflows: does not apply the ownership filter when entityTypeId is provided", async () => {
    selectQueue = [() => []]; // rows.length === 0 short-circuits before the states/transitions/count selects
    await listWorkflows(
      dbMock as never,
      TENANT_ID,
      NON_ADMIN_CALLER,
      "entity-type-1",
    );

    const ownershipCheck = vi
      .mocked(eq)
      .mock.calls.find(([, val]) => val === NON_ADMIN_CALLER.userId);
    expect(ownershipCheck).toBeUndefined();
  });

  it("listWorkflows: also does not apply the ownership filter for a bare call (no entityTypeId) — a signed-off widening beyond the original spec's §C/R1 (see spec amendment note), needed by the records page's tenant-wide workflow-discovery feature for general users", async () => {
    selectQueue = [() => []];
    await listWorkflows(dbMock as never, TENANT_ID, NON_ADMIN_CALLER);

    const ownershipCheck = vi
      .mocked(eq)
      .mock.calls.find(([, val]) => val === NON_ADMIN_CALLER.userId);
    expect(ownershipCheck).toBeUndefined();
  });

  it("listWorkflows: returns an empty array, not an error, when no workflow governs the entity type", async () => {
    selectQueue = [() => []];
    const result = await listWorkflows(
      dbMock as never,
      TENANT_ID,
      NON_ADMIN_CALLER,
      "entity-type-ungoverned",
    );
    expect(result).toEqual([]);
  });

  it("listWorkflowsSummary: does not apply the ownership filter when entityTypeId is provided", async () => {
    selectQueue = [() => []];
    await listWorkflowsSummary(
      dbMock as never,
      TENANT_ID,
      NON_ADMIN_CALLER,
      "entity-type-1",
    );

    const ownershipCheck = vi
      .mocked(eq)
      .mock.calls.find(([, val]) => val === NON_ADMIN_CALLER.userId);
    expect(ownershipCheck).toBeUndefined();
  });

  it("listWorkflowsSummary: also does not apply the ownership filter for a bare call (no entityTypeId) — same signed-off widening as listWorkflows above", async () => {
    selectQueue = [() => []];
    await listWorkflowsSummary(dbMock as never, TENANT_ID, NON_ADMIN_CALLER);

    const ownershipCheck = vi
      .mocked(eq)
      .mock.calls.find(([, val]) => val === NON_ADMIN_CALLER.userId);
    expect(ownershipCheck).toBeUndefined();
  });

  it("getWorkflowByEntityTypeId takes no caller/ownership input — regression guard that it stays untouched by this change", async () => {
    selectQueue = [
      () => [{ id: WORKFLOW_ID, createdBy: "someone-else", assignedTo: [] }],
    ];
    const result = await getWorkflowByEntityTypeId(
      dbMock as never,
      TENANT_ID,
      "entity-type-1",
    );
    // No caller/userId argument exists on this function's signature (TS-enforced);
    // this asserts the runtime behavior matches: it returns whatever row matches
    // tenant+entityType, with no ownership check applied at all — same as before.
    expect(result?.id).toBe(WORKFLOW_ID);
  });
});

describe("addWorkflowState — initialState auto-heal", () => {
  it("heals workflows.initialState to the first state's name when it's the first state and non-terminal", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // assertWorkflowOwned
      () => [{ value: 0 }], // existing state count — none yet
    ];
    insertReturnRow = {
      id: STATE_ID,
      workflowId: WORKFLOW_ID,
      name: "open",
      label: "Open",
      color: "#888",
      isTerminal: false,
      slaHours: null,
      sortOrder: 0,
    };

    await addWorkflowState(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
      name: "open",
      label: "Open",
      color: "#888",
    });

    const healUpdate = updateCalls.find((c) => c.table === "workflows_mock");
    expect(healUpdate).toBeDefined();
    expect(healUpdate?.setVals).toEqual({ initialState: "open" });
    // Required fix (PR #339 review): the heal UPDATE must filter by tenantId,
    // not just workflow id.
    expect(JSON.stringify(healUpdate?.whereArgs)).toContain(TENANT_ID);
  });

  it("does not heal when the first state created is terminal", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // assertWorkflowOwned
      () => [{ value: 0 }], // existing state count — none yet
    ];
    insertReturnRow = {
      id: STATE_ID,
      workflowId: WORKFLOW_ID,
      name: "closed",
      label: "Closed",
      color: "#888",
      isTerminal: true,
      slaHours: null,
      sortOrder: 0,
    };

    await addWorkflowState(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
      name: "closed",
      label: "Closed",
      color: "#888",
      isTerminal: true,
    });

    const healUpdate = updateCalls.find((c) => c.table === "workflows_mock");
    expect(healUpdate).toBeUndefined();
  });

  it("does not heal when a state already exists on the workflow", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // assertWorkflowOwned
      () => [{ value: 1 }], // existing state count — one already
    ];
    insertReturnRow = {
      id: "state-2",
      workflowId: WORKFLOW_ID,
      name: "in_progress",
      label: "In Progress",
      color: "#888",
      isTerminal: false,
      slaHours: null,
      sortOrder: 1,
    };

    await addWorkflowState(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
      name: "in_progress",
      label: "In Progress",
      color: "#888",
    });

    const healUpdate = updateCalls.find((c) => c.table === "workflows_mock");
    expect(healUpdate).toBeUndefined();
  });
});

describe("updateWorkflow — initialState validation", () => {
  it("accepts a valid non-terminal initialState", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // load workflow (visibleTo check)
      () => [{ isTerminal: false }], // target state lookup
    ];

    await updateWorkflow(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
      initialState: "in_progress",
    });

    const workflowUpdate = updateCalls.find(
      (c) => c.table === "workflows_mock",
    );
    expect(workflowUpdate?.setVals).toEqual({
      initialState: "in_progress",
    });
    expect(JSON.stringify(workflowUpdate?.whereArgs)).toContain(TENANT_ID);
  });

  it("throws WORKFLOW_INITIAL_STATE_INVALID for a terminal state name", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // load workflow
      () => [{ isTerminal: true }], // target state is terminal
    ];

    await expect(
      updateWorkflow(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
        initialState: "closed",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INITIAL_STATE_INVALID" });

    expect(updateCalls).toHaveLength(0);
  });

  it("throws WORKFLOW_INITIAL_STATE_INVALID when the named state doesn't exist on the workflow", async () => {
    selectQueue = [
      () => [ownedWorkflowRow], // load workflow
      () => [], // target state lookup — no match
    ];

    await expect(
      updateWorkflow(dbMock as never, TENANT_ID, WORKFLOW_ID, CALLER, {
        initialState: "nonexistent",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INITIAL_STATE_INVALID" });

    expect(updateCalls).toHaveLength(0);
  });
});
