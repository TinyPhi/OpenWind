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

const dbMock = {
  select: vi.fn(() => makeQueryBuilder(mockSelectResult)),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({ returning: mockInsertReturning })),
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
    deletedAt: { deleted_at: "deleted_at" },
  },
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

const { createRelation, listRelations, deleteRelation } =
  await import("./entity-relations.js");

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
