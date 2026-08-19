import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @platform/db ─────────────────────────────────────────────────────────

const mockInsertReturning = vi.fn();
const mockSelectResult = vi.fn();

function makeQueryBuilder(finalResult: () => unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["orderBy"] = () => q;
  q["limit"] = () => q;
  q["select"] = () => q;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(finalResult()).then(resolve);
  return q;
}

const mockUpdateSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) }));
const mockInsertValues = vi.fn((table: unknown, rows: unknown) => ({
  returning: mockInsertReturning,
  rows,
  table,
}));

const dbMock = {
  select: vi.fn(() => makeQueryBuilder(mockSelectResult)),
  insert: vi.fn((table: unknown) => ({
    values: (rows: unknown) => mockInsertValues(table, rows),
  })),
  delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
  update: vi.fn(() => ({ set: mockUpdateSet })),
};

vi.mock("@platform/db", () => ({
  entityRelations: {
    id: "id",
    tenantId: "tenant_id",
    fromInstanceId: "from_instance_id",
    toInstanceId: "to_instance_id",
    relationType: "relation_type",
    createdAt: "created_at",
  },
  entityInstances: {
    id: "id",
    tenantId: "tenant_id",
    workflowId: "workflow_id",
    currentState: "current_state",
    deletedAt: { deleted_at: "deleted_at" },
  },
  workflowEvents: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
  gt: vi.fn((col, val) => ({ col, val, op: "gt" })),
  sql: vi.fn((s) => ({ raw: s })),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────

const {
  createRelation,
  listRelations,
  deleteRelation,
  createReferenceLink,
  deleteReferenceLink,
} = await import("./entity-relations.js");

const TENANT_ID = "tenant-aaa";
const FROM_ID = "instance-from";
const TO_ID = "instance-to";
const RELATION_ID = "relation-ccc";

const fakeRelation = {
  id: RELATION_ID,
  tenantId: TENANT_ID,
  fromInstanceId: FROM_ID,
  toInstanceId: TO_ID,
  relationType: "parent",
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

describe("createRelation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a relation when both instances belong to the tenant", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TO_ID }]));
    mockInsertReturning.mockResolvedValue([fakeRelation]);

    const result = await createRelation(dbMock as never, TENANT_ID, {
      fromInstanceId: FROM_ID,
      toInstanceId: TO_ID,
      relationType: "parent",
    });

    expect(result.id).toBe(RELATION_ID);
    expect(result.relationType).toBe("parent");
  });

  it("throws RELATION_TARGET_NOT_FOUND when fromInstance does not belong to tenant", async () => {
    dbMock.select.mockReturnValueOnce(makeQueryBuilder(() => []));

    await expect(
      createRelation(dbMock as never, TENANT_ID, {
        fromInstanceId: "nonexistent",
        toInstanceId: TO_ID,
        relationType: "parent",
      }),
    ).rejects.toMatchObject({ code: "RELATION_TARGET_NOT_FOUND" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws RELATION_TARGET_NOT_FOUND when toInstance does not belong to tenant", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => []));

    await expect(
      createRelation(dbMock as never, TENANT_ID, {
        fromInstanceId: FROM_ID,
        toInstanceId: "nonexistent",
        relationType: "parent",
      }),
    ).rejects.toMatchObject({ code: "RELATION_TARGET_NOT_FOUND" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws RELATION_TARGET_NOT_FOUND when fromInstance is soft-deleted", async () => {
    // isNull(deletedAt) filter causes soft-deleted instances to return empty
    dbMock.select.mockReturnValueOnce(makeQueryBuilder(() => []));

    await expect(
      createRelation(dbMock as never, TENANT_ID, {
        fromInstanceId: FROM_ID,
        toInstanceId: TO_ID,
        relationType: "parent",
      }),
    ).rejects.toMatchObject({ code: "RELATION_TARGET_NOT_FOUND" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws RELATION_TARGET_NOT_FOUND when toInstance is soft-deleted", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => []));

    await expect(
      createRelation(dbMock as never, TENANT_ID, {
        fromInstanceId: FROM_ID,
        toInstanceId: TO_ID,
        relationType: "parent",
      }),
    ).rejects.toMatchObject({ code: "RELATION_TARGET_NOT_FOUND" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe("createRelation — link history events (§3.1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a link_created workflow_events row on BOTH tickets when each resolves a workflow", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }])) // from exists
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TO_ID }])) // to exists
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          { workflowId: "wf-from", currentState: "open" },
        ]),
      ) // from's own workflow context
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ workflowId: "wf-to", currentState: "new" }]),
      ); // to's own workflow context
    mockInsertReturning.mockResolvedValue([fakeRelation]);

    await createRelation(dbMock as never, TENANT_ID, {
      fromInstanceId: FROM_ID,
      toInstanceId: TO_ID,
      relationType: "blocks",
      actorId: "u-actor",
    });

    // entityRelations (1 call) + workflowEvents (2 calls, one per side).
    expect(mockInsertValues.mock.calls.length).toBe(3);

    const historyRows = mockInsertValues.mock.calls
      .slice(1)
      .map(([, rows]) => rows as Record<string, unknown>);
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toMatchObject({
      instanceId: FROM_ID,
      workflowId: "wf-from",
      actorId: "u-actor",
      metadata: {
        type: "link_created",
        counterpartId: TO_ID,
        relationType: "blocks",
      },
    });
    expect(historyRows[1]).toMatchObject({
      instanceId: TO_ID,
      workflowId: "wf-to",
      actorId: "u-actor",
      metadata: {
        type: "link_created",
        counterpartId: FROM_ID,
        relationType: "blocks",
      },
    });
  });

  it("does not throw and still returns the created relation when neither side resolves a workflow", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TO_ID }]))
      // Both history lookups return nothing resolvable — the entity_instances
      // select comes back empty, so resolveWorkflowContextForHistory bails.
      .mockReturnValue(makeQueryBuilder(() => []));
    mockInsertReturning.mockResolvedValue([fakeRelation]);

    const result = await createRelation(dbMock as never, TENANT_ID, {
      fromInstanceId: FROM_ID,
      toInstanceId: TO_ID,
      relationType: "blocks",
    });

    expect(result.id).toBe(RELATION_ID);
    // Only the original entityRelations insert — no workflow_events rows.
    expect(mockInsertValues.mock.calls.length).toBe(1);
  });
});

describe("deleteRelation — link history events (§3.2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a link_removed workflow_events row on both tickets", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: RELATION_ID,
            fromInstanceId: FROM_ID,
            toInstanceId: TO_ID,
            relationType: "blocks",
          },
        ]),
      )
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          { workflowId: "wf-from", currentState: "open" },
        ]),
      )
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ workflowId: "wf-to", currentState: "new" }]),
      );

    await deleteRelation(dbMock as never, TENANT_ID, RELATION_ID, "u-actor");

    const historyRows = mockInsertValues.mock.calls.map(
      ([, rows]) => rows as Record<string, unknown>,
    );
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toMatchObject({
      instanceId: FROM_ID,
      metadata: { type: "link_removed", counterpartId: TO_ID },
    });
    expect(historyRows[1]).toMatchObject({
      instanceId: TO_ID,
      metadata: { type: "link_removed", counterpartId: FROM_ID },
    });
  });
});

describe("listRelations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a cursor page of relations for an instance", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeRelation]));

    const page = await listRelations(dbMock as never, TENANT_ID, FROM_ID);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.relationType).toBe("parent");
    expect(page.nextCursor).toBeNull();
  });

  it("returns empty page when no relations found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));

    const page = await listRelations(dbMock as never, TENANT_ID, FROM_ID, {
      direction: "from",
    });

    expect(page.data).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("sets nextCursor when more results exist beyond the limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...fakeRelation,
      id: `relation-${i}`,
      createdAt: new Date(Date.now() + i * 1000),
    }));
    dbMock.select.mockReturnValue(makeQueryBuilder(() => rows));

    const page = await listRelations(dbMock as never, TENANT_ID, FROM_ID, {
      limit: 2,
    });

    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("filters by relationType when provided", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeRelation]));

    const page = await listRelations(dbMock as never, TENANT_ID, FROM_ID, {
      relationType: "parent",
    });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.relationType).toBe("parent");
  });
});

describe("createReferenceLink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a mirrored references/referenced_by pair for two different entity instances", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }])) // from exists
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TO_ID }])) // to exists
      .mockReturnValueOnce(makeQueryBuilder(() => [])); // no existing active link
    mockInsertReturning.mockResolvedValue([
      { ...fakeRelation, relationType: "references" },
      {
        ...fakeRelation,
        id: "relation-ddd",
        fromInstanceId: TO_ID,
        toInstanceId: FROM_ID,
        relationType: "referenced_by",
      },
    ]);

    const result = await createReferenceLink(dbMock as never, TENANT_ID, {
      fromInstanceId: FROM_ID,
      toInstanceId: TO_ID,
    });

    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]?.relationType).toBe("references");
    expect(result.relations[1]?.relationType).toBe("referenced_by");
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it("throws RELATION_SELF_LINK when fromInstanceId equals toInstanceId", async () => {
    await expect(
      createReferenceLink(dbMock as never, TENANT_ID, {
        fromInstanceId: FROM_ID,
        toInstanceId: FROM_ID,
      }),
    ).rejects.toMatchObject({ code: "RELATION_SELF_LINK" });

    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws RELATION_TARGET_NOT_FOUND when fromInstance does not belong to tenant or is soft-deleted", async () => {
    dbMock.select.mockReturnValueOnce(makeQueryBuilder(() => []));

    await expect(
      createReferenceLink(dbMock as never, TENANT_ID, {
        fromInstanceId: "nonexistent",
        toInstanceId: TO_ID,
      }),
    ).rejects.toMatchObject({ code: "RELATION_TARGET_NOT_FOUND" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws RELATION_TARGET_NOT_FOUND when toInstance does not belong to tenant or is soft-deleted", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => []));

    await expect(
      createReferenceLink(dbMock as never, TENANT_ID, {
        fromInstanceId: FROM_ID,
        toInstanceId: "nonexistent",
      }),
    ).rejects.toMatchObject({ code: "RELATION_TARGET_NOT_FOUND" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws RELATION_ALREADY_EXISTS when an active references link already exists for this exact pair", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TO_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: RELATION_ID }]));

    await expect(
      createReferenceLink(dbMock as never, TENANT_ID, {
        fromInstanceId: FROM_ID,
        toInstanceId: TO_ID,
      }),
    ).rejects.toMatchObject({ code: "RELATION_ALREADY_EXISTS" });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("writes a reference_created workflow_events row on both tickets (§3.1)", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: FROM_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TO_ID }]))
      .mockReturnValueOnce(makeQueryBuilder(() => [])) // no existing active link
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          { workflowId: "wf-from", currentState: "open" },
        ]),
      )
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ workflowId: "wf-to", currentState: "new" }]),
      );
    mockInsertReturning.mockResolvedValue([
      { ...fakeRelation, relationType: "references" },
      {
        ...fakeRelation,
        id: "relation-ddd",
        fromInstanceId: TO_ID,
        toInstanceId: FROM_ID,
        relationType: "referenced_by",
      },
    ]);

    await createReferenceLink(dbMock as never, TENANT_ID, {
      fromInstanceId: FROM_ID,
      toInstanceId: TO_ID,
      actorId: "u-actor",
    });

    // insert #1 is the mirrored entityRelations pair (one .values() call with
    // both rows); insert #2/#3 are the two workflow_events history rows.
    const historyRows = mockInsertValues.mock.calls
      .slice(1)
      .map(([, rows]) => rows as Record<string, unknown>);
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toMatchObject({
      instanceId: FROM_ID,
      actorId: "u-actor",
      metadata: { type: "reference_created", counterpartId: TO_ID },
    });
    expect(historyRows[1]).toMatchObject({
      instanceId: TO_ID,
      actorId: "u-actor",
      metadata: { type: "reference_created", counterpartId: FROM_ID },
    });
  });
});

describe("deleteReferenceLink — link history events (§3.2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a reference_removed workflow_events row on both tickets", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: RELATION_ID,
            fromInstanceId: FROM_ID,
            toInstanceId: TO_ID,
            relationType: "references",
          },
        ]),
      )
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          { workflowId: "wf-from", currentState: "open" },
        ]),
      )
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ workflowId: "wf-to", currentState: "new" }]),
      );

    await deleteReferenceLink(
      dbMock as never,
      TENANT_ID,
      RELATION_ID,
      "u-actor",
    );

    const historyRows = mockInsertValues.mock.calls.map(
      ([, rows]) => rows as Record<string, unknown>,
    );
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toMatchObject({
      instanceId: FROM_ID,
      metadata: { type: "reference_removed", counterpartId: TO_ID },
    });
    expect(historyRows[1]).toMatchObject({
      instanceId: TO_ID,
      metadata: { type: "reference_removed", counterpartId: FROM_ID },
    });
  });
});

describe("deleteRelation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("soft-deletes the relation (sets deleted_at) when it belongs to the tenant", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [{ id: RELATION_ID }]),
    );

    await expect(
      deleteRelation(dbMock as never, TENANT_ID, RELATION_ID),
    ).resolves.toBeUndefined();

    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("throws RELATION_NOT_FOUND when relation does not exist or belongs to another tenant", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));

    await expect(
      deleteRelation(dbMock as never, TENANT_ID, "nonexistent"),
    ).rejects.toMatchObject({ code: "RELATION_NOT_FOUND" });

    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
