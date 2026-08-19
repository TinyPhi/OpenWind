import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQ(result: () => unknown[]) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q["from"] = chain;
  q["where"] = chain;
  q["limit"] = chain;
  q["for"] = chain;
  q["select"] = chain;
  q["orderBy"] = chain;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(result()).then(resolve);
  return q;
}

const mockInsertReturning = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockSelectSeq: Array<() => unknown[]> = [];
const mockInsertValues = vi.fn();
let selectCallIndex = 0;

function nextSelect() {
  const fn = mockSelectSeq[selectCallIndex++];
  return makeQ(fn ?? (() => []));
}

const dbMock = {
  select: vi.fn(() => nextSelect()),
  insert: vi.fn(() => ({
    values: vi.fn((payload: unknown) => {
      mockInsertValues(payload);
      return { returning: mockInsertReturning };
    }),
  })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) })),
};

vi.mock("@platform/db", () => ({
  entityRelations: {
    id: "id",
    tenantId: "tenant_id",
    fromInstanceId: "from_instance_id",
    toInstanceId: "to_instance_id",
    relationType: "relation_type",
    deletedAt: "deleted_at",
    createdAt: "created_at",
  },
  entityInstances: {
    id: "id",
    tenantId: "tenant_id",
    workflowId: "workflow_id",
    deletedAt: "deleted_at",
    assignedTo: "assigned_to",
    fields: "fields",
    currentState: "current_state",
    updatedAt: "updated_at",
  },
  entityFields: {
    id: "id",
    entityTypeId: "entity_type_id",
    tenantId: "tenant_id",
  },
  workflows: {
    id: "id",
    maxChildDepth: "max_child_depth",
    maxChildrenPerParent: "max_children_per_parent",
  },
  workflowEvents: {
    id: "id",
    tenantId: "tenant_id",
    instanceId: "instance_id",
    workflowId: "workflow_id",
    fromState: "from_state",
    toState: "to_state",
    triggeredBy: "triggered_by",
    actorId: "actor_id",
    comment: "comment",
    metadata: "metadata",
  },
  outboxEvents: {
    id: "id",
    tenantId: "tenant_id",
    eventType: "event_type",
    version: "version",
    payload: "payload",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  count: vi.fn(() => "count(*)"),
  sql: vi.fn((s) => ({ raw: s })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
  notExists: vi.fn((sub) => ({ sub, op: "notExists" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
  gt: vi.fn((col, val) => ({ col, val, op: "gt" })),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createChildRelation, moveChildRelation, canUserReadInstance } =
  await import("./child-relations.js");

const TENANT = "tenant-aaa";
const PARENT_ID = "parent-111";
const CHILD_ID = "child-222";
const WORKFLOW_ID = "wf-333";

const fakeParent = {
  id: PARENT_ID,
  workflowId: WORKFLOW_ID,
  deletedAt: null,
};
const fakeLimits = { maxChildDepth: 1, maxChildrenPerParent: 10 };
const fakeChild = {
  id: CHILD_ID,
  entityTypeId: "et-aaa",
  tenantId: TENANT,
  workflowId: null,
  currentState: "open",
  fields: { child_status: "open" },
  createdBy: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};
const fakeRelPair = [
  {
    id: "rel-1",
    tenantId: TENANT,
    fromInstanceId: PARENT_ID,
    toInstanceId: CHILD_ID,
    relationType: "parent_of",
    createdAt: new Date(),
    deletedAt: null,
  },
  {
    id: "rel-2",
    tenantId: TENANT,
    fromInstanceId: CHILD_ID,
    toInstanceId: PARENT_ID,
    relationType: "child_of",
    createdAt: new Date(),
    deletedAt: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectSeq.length = 0;
  selectCallIndex = 0;
});

// ── createChildRelation ───────────────────────────────────────────────────────

describe("createChildRelation", () => {
  it("creates child instance + relation pair when all constraints pass", async () => {
    // 1: load parent (FOR UPDATE)
    mockSelectSeq.push(() => [fakeParent]);
    // 2: loadWorkflowLimits
    mockSelectSeq.push(() => [fakeLimits]);
    // 3: getAncestorDepth — parent has no child_of → depth 0
    mockSelectSeq.push(() => []);
    // 4: countActiveChildren — 0 children
    mockSelectSeq.push(() => [{ n: 0 }]);
    // 5: loadEntityFields (for the entity.created outbox payload, IMP-6)
    mockSelectSeq.push(() => []);
    mockInsertReturning
      .mockResolvedValueOnce([fakeChild]) // entity_instances insert
      .mockResolvedValueOnce(fakeRelPair); // entity_relations insert

    const result = await createChildRelation(dbMock as never, TENANT, {
      parentId: PARENT_ID,
      childFields: { title: "Sub-task" },
      entityTypeId: "et-aaa",
    });

    expect(result.instance.id).toBe(CHILD_ID);
    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]?.relationType).toBe("parent_of");
    expect(result.relations[1]?.relationType).toBe("child_of");
  });

  it("stores the provided dueDate on the child instance", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [fakeLimits]);
    mockSelectSeq.push(() => []); // ancestorDepth = 0
    mockSelectSeq.push(() => [{ n: 0 }]); // countActiveChildren
    mockSelectSeq.push(() => []); // loadEntityFields
    mockInsertReturning
      .mockResolvedValueOnce([fakeChild])
      .mockResolvedValueOnce(fakeRelPair);

    await createChildRelation(dbMock as never, TENANT, {
      parentId: PARENT_ID,
      childFields: { title: "Sub-task" },
      entityTypeId: "et-aaa",
      dueDate: "2026-09-01T00:00:00.000Z",
    });

    const insertCall = mockInsertValues.mock.calls.find(
      (call) => (call[0] as { fields?: unknown })?.fields !== undefined,
    );
    expect((insertCall?.[0] as { dueDate?: Date })?.dueDate).toEqual(
      new Date("2026-09-01T00:00:00.000Z"),
    );
  });

  it("leaves dueDate null when none is provided", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [fakeLimits]);
    mockSelectSeq.push(() => []); // ancestorDepth = 0
    mockSelectSeq.push(() => [{ n: 0 }]); // countActiveChildren
    mockSelectSeq.push(() => []); // loadEntityFields
    mockInsertReturning
      .mockResolvedValueOnce([fakeChild])
      .mockResolvedValueOnce(fakeRelPair);

    await createChildRelation(dbMock as never, TENANT, {
      parentId: PARENT_ID,
      childFields: { title: "Sub-task" },
      entityTypeId: "et-aaa",
    });

    const insertCall = mockInsertValues.mock.calls.find(
      (call) => (call[0] as { fields?: unknown })?.fields !== undefined,
    );
    expect((insertCall?.[0] as { dueDate?: Date | null })?.dueDate).toBeNull();
  });

  it("emits an entity.created outbox event for the child (IMP-6)", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [fakeLimits]);
    mockSelectSeq.push(() => []); // ancestorDepth = 0
    mockSelectSeq.push(() => [{ n: 0 }]); // countActiveChildren
    mockSelectSeq.push(() => []); // loadEntityFields
    mockInsertReturning
      .mockResolvedValueOnce([fakeChild])
      .mockResolvedValueOnce(fakeRelPair);

    await createChildRelation(dbMock as never, TENANT, {
      parentId: PARENT_ID,
      childFields: { title: "Sub-task" },
      entityTypeId: "et-aaa",
    });

    const outboxCall = mockInsertValues.mock.calls.find((call) =>
      (call[0] as Array<{ eventType?: string }>)?.some?.(
        (row) => row.eventType === "entity.created",
      ),
    );
    expect(outboxCall).toBeDefined();
    const rows = outboxCall?.[0] as Array<{
      eventType: string;
      payload: { instanceId: string; entityTypeId: string };
    }>;
    const payload = rows.find((row) => row.eventType === "entity.created");
    expect(payload?.payload.instanceId).toBe(CHILD_ID);
    expect(payload?.payload.entityTypeId).toBe("et-aaa");
  });

  it("also emits an entity.assigned outbox event when the child is assigned at creation", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [fakeLimits]);
    mockSelectSeq.push(() => []); // ancestorDepth = 0
    mockSelectSeq.push(() => [{ n: 0 }]); // countActiveChildren
    mockSelectSeq.push(() => []); // loadEntityFields
    mockInsertReturning
      .mockResolvedValueOnce([{ ...fakeChild, assignedTo: "user-ccc" }])
      .mockResolvedValueOnce(fakeRelPair);

    await createChildRelation(dbMock as never, TENANT, {
      parentId: PARENT_ID,
      childFields: { title: "Sub-task" },
      entityTypeId: "et-aaa",
      assignedTo: "user-ccc",
      createdBy: "user-bbb",
    });

    const outboxCall = mockInsertValues.mock.calls.find((call) =>
      (call[0] as Array<{ eventType?: string }>)?.some?.(
        (row) => row.eventType === "entity.assigned",
      ),
    );
    expect(outboxCall).toBeDefined();
    const rows = outboxCall?.[0] as Array<{
      eventType: string;
      payload: {
        instanceId: string;
        assigneeId: string;
        assignedBy: string | null;
      };
    }>;
    const payload = rows.find((row) => row.eventType === "entity.assigned");
    expect(payload?.payload.instanceId).toBe(CHILD_ID);
    expect(payload?.payload.assigneeId).toBe("user-ccc");
    expect(payload?.payload.assignedBy).toBe("user-bbb");
  });

  it("does not emit an entity.assigned outbox event when the child has no assignee", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [fakeLimits]);
    mockSelectSeq.push(() => []); // ancestorDepth = 0
    mockSelectSeq.push(() => [{ n: 0 }]); // countActiveChildren
    mockSelectSeq.push(() => []); // loadEntityFields
    mockInsertReturning
      .mockResolvedValueOnce([fakeChild])
      .mockResolvedValueOnce(fakeRelPair);

    await createChildRelation(dbMock as never, TENANT, {
      parentId: PARENT_ID,
      childFields: { title: "Sub-task" },
      entityTypeId: "et-aaa",
    });

    const outboxCall = mockInsertValues.mock.calls.find((call) =>
      (call[0] as Array<{ eventType?: string }>)?.some?.(
        (row) => row.eventType === "entity.assigned",
      ),
    );
    expect(outboxCall).toBeUndefined();
  });

  it("throws ENTITY_NOT_FOUND when parent is archived (deleted_at set)", async () => {
    mockSelectSeq.push(() => [{ ...fakeParent, deletedAt: new Date() }]);

    await expect(
      createChildRelation(dbMock as never, TENANT, {
        parentId: PARENT_ID,
        childFields: {},
        entityTypeId: "et-aaa",
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });

  it("throws CHILDREN_DISABLED when workflow.max_child_depth is 0", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [{ maxChildDepth: 0, maxChildrenPerParent: 10 }]);

    await expect(
      createChildRelation(dbMock as never, TENANT, {
        parentId: PARENT_ID,
        childFields: {},
        entityTypeId: "et-aaa",
      }),
    ).rejects.toMatchObject({ code: "CHILDREN_DISABLED" });
  });

  it("throws CHILD_DEPTH_EXCEEDED when parent is already at max depth", async () => {
    // Parent is itself a child (ancestorDepth = 1), maxChildDepth = 1
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [fakeLimits]); // maxChildDepth = 1
    // getAncestorDepth: parent has a child_of relation → depth 1
    mockSelectSeq.push(() => [{ toInstanceId: "grandparent-id" }]);
    // second hop: grandparent has no child_of
    mockSelectSeq.push(() => []);

    await expect(
      createChildRelation(dbMock as never, TENANT, {
        parentId: PARENT_ID,
        childFields: {},
        entityTypeId: "et-aaa",
      }),
    ).rejects.toMatchObject({ code: "CHILD_DEPTH_EXCEEDED" });
  });

  it("throws CHILDREN_CAP_EXCEEDED when parent is at the children cap", async () => {
    mockSelectSeq.push(() => [fakeParent]);
    mockSelectSeq.push(() => [{ maxChildDepth: 1, maxChildrenPerParent: 2 }]);
    mockSelectSeq.push(() => []); // ancestorDepth = 0
    mockSelectSeq.push(() => [{ n: 2 }]); // already at cap

    await expect(
      createChildRelation(dbMock as never, TENANT, {
        parentId: PARENT_ID,
        childFields: {},
        entityTypeId: "et-aaa",
      }),
    ).rejects.toMatchObject({ code: "CHILDREN_CAP_EXCEEDED" });
  });

  it("throws CHILDREN_DISABLED when parent has no workflow_id", async () => {
    mockSelectSeq.push(() => [{ ...fakeParent, workflowId: null }]);

    await expect(
      createChildRelation(dbMock as never, TENANT, {
        parentId: PARENT_ID,
        childFields: {},
        entityTypeId: "et-aaa",
      }),
    ).rejects.toMatchObject({ code: "CHILDREN_DISABLED" });
  });
});

// ── moveChildRelation ─────────────────────────────────────────────────────────

describe("moveChildRelation", () => {
  const NEW_PARENT_ID = "new-parent-444";
  const fakeNewParent = {
    id: NEW_PARENT_ID,
    workflowId: WORKFLOW_ID,
    deletedAt: null,
  };

  it("detaches ticket when newParentId is null", async () => {
    // lock child
    mockSelectSeq.push(() => [{ id: CHILD_ID, deletedAt: null }]);

    const result = await moveChildRelation(dbMock as never, TENANT, {
      childId: CHILD_ID,
      newParentId: null,
    });

    expect(result).toHaveLength(0);
    expect(dbMock.update).toHaveBeenCalled();
  });

  it("re-parents ticket when new parent is valid", async () => {
    // lock child
    mockSelectSeq.push(() => [{ id: CHILD_ID, deletedAt: null }]);
    // find old parent_of mirror row
    mockSelectSeq.push(() => [{ id: "old-rel-id" }]);
    // lock new parent
    mockSelectSeq.push(() => [fakeNewParent]);
    // loadWorkflowLimits
    mockSelectSeq.push(() => [fakeLimits]);
    // collectDescendantIds for cycle detection — child has no children
    mockSelectSeq.push(() => []);
    // getAncestorDepth of newParent — 0
    mockSelectSeq.push(() => []);
    // getDescendantDepth of child — 0
    mockSelectSeq.push(() => []);
    // countActiveChildren on new parent — 0
    mockSelectSeq.push(() => [{ n: 0 }]);

    mockInsertReturning.mockResolvedValue(fakeRelPair);

    const result = await moveChildRelation(dbMock as never, TENANT, {
      childId: CHILD_ID,
      newParentId: NEW_PARENT_ID,
    });

    expect(result).toHaveLength(2);
  });

  it("throws CHILD_CYCLE_DETECTED when new parent is a descendant of the child", async () => {
    mockSelectSeq.push(() => [{ id: CHILD_ID, deletedAt: null }]);
    // old parent_of mirror
    mockSelectSeq.push(() => [{ id: "old-rel-id" }]);
    // lock new parent
    mockSelectSeq.push(() => [fakeNewParent]);
    // loadWorkflowLimits
    mockSelectSeq.push(() => [fakeLimits]);
    // collectDescendantIds — NEW_PARENT_ID is already a descendant of child
    mockSelectSeq.push(() => [{ toInstanceId: NEW_PARENT_ID }]);
    // second hop descendants
    mockSelectSeq.push(() => []);

    await expect(
      moveChildRelation(dbMock as never, TENANT, {
        childId: CHILD_ID,
        newParentId: NEW_PARENT_ID,
      }),
    ).rejects.toMatchObject({ code: "CHILD_CYCLE_DETECTED" });
  });

  it("throws CHILD_CYCLE_DETECTED when newParentId equals childId (self-parent)", async () => {
    mockSelectSeq.push(() => [{ id: CHILD_ID, deletedAt: null }]);
    // old parent_of mirror
    mockSelectSeq.push(() => [{ id: "old-rel-id" }]);
    // lock "new parent" — same row as the child itself
    mockSelectSeq.push(() => [
      { id: CHILD_ID, workflowId: WORKFLOW_ID, deletedAt: null },
    ]);
    // loadWorkflowLimits
    mockSelectSeq.push(() => [fakeLimits]);
    // collectDescendantIds — child has no actual descendants; the self-parent
    // case must be caught even though it never appears in this list
    mockSelectSeq.push(() => []);

    await expect(
      moveChildRelation(dbMock as never, TENANT, {
        childId: CHILD_ID,
        newParentId: CHILD_ID,
      }),
    ).rejects.toMatchObject({ code: "CHILD_CYCLE_DETECTED" });
  });
});

// ── canUserReadInstance ───────────────────────────────────────────────────────

describe("canUserReadInstance", () => {
  it("returns true for admin role regardless of assignment", async () => {
    const result = await canUserReadInstance(
      dbMock as never,
      TENANT,
      "some-user",
      "admin",
      CHILD_ID,
    );
    expect(result).toBe(true);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("returns true for agent role regardless of assignment", async () => {
    const result = await canUserReadInstance(
      dbMock as never,
      TENANT,
      "some-user",
      "agent",
      CHILD_ID,
    );
    expect(result).toBe(true);
  });

  it("returns true when user is directly assigned to the ticket", async () => {
    mockSelectSeq.push(() => [{ assignedTo: "user-xyz" }]);
    // no parent chain needed

    const result = await canUserReadInstance(
      dbMock as never,
      TENANT,
      "user-xyz",
      "user",
      CHILD_ID,
    );
    expect(result).toBe(true);
  });

  it("returns true when user is assigned to a parent ticket (coordinator visibility)", async () => {
    // direct assignment check — different user
    mockSelectSeq.push(() => [{ assignedTo: "agent-abc" }]);
    // walk up: child_of relation → parent
    mockSelectSeq.push(() => [{ toInstanceId: PARENT_ID }]);
    // parent's assignedTo = "user-xyz"
    mockSelectSeq.push(() => [{ assignedTo: "user-xyz" }]);

    const result = await canUserReadInstance(
      dbMock as never,
      TENANT,
      "user-xyz",
      "user",
      CHILD_ID,
    );
    expect(result).toBe(true);
  });

  it("returns false when user is not assigned to ticket or any ancestor", async () => {
    mockSelectSeq.push(() => [{ assignedTo: "agent-abc" }]);
    // no parent
    mockSelectSeq.push(() => []);

    const result = await canUserReadInstance(
      dbMock as never,
      TENANT,
      "user-xyz",
      "user",
      CHILD_ID,
    );
    expect(result).toBe(false);
  });
});
