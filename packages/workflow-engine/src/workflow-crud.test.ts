import { describe, it, expect, vi, beforeEach } from "vitest";

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
  q["limit"] = () => q;
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
      return {
        returning: vi
          .fn()
          .mockResolvedValue(
            table === "workflow_states_mock" ? [updatedStateRow] : [],
          ),
      };
    }),
  })),
}));

const dbMock = {
  select: vi.fn(() => {
    const result = selectQueue[selectCallCount] ?? (() => []);
    selectCallCount++;
    return makeSelectBuilder(result);
  }),
  update: mockUpdate,
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

const { updateWorkflowState } = await import("./workflow-crud.js");

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
