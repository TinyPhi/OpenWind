import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock helpers ──────────────────────────────────────────────────────────────

const mockSelectSeq: Array<() => unknown[]> = [];
let selectCallIndex = 0;

function makeQ(result: () => unknown[]) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q["from"] = chain;
  q["where"] = chain;
  q["limit"] = chain;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(result()).then(resolve);
  return q;
}

const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockExecute = vi.fn().mockResolvedValue([]);

const dbMock = {
  select: vi.fn(() => makeQ(mockSelectSeq[selectCallIndex++] ?? (() => []))),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: mockUpdateWhere })),
  })),
  execute: mockExecute,
};

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "id",
    tenantId: "tenant_id",
    deletedAt: "deleted_at",
  },
  entityRelations: {
    id: "id",
    tenantId: "tenant_id",
    fromInstanceId: "from_instance_id",
    toInstanceId: "to_instance_id",
    relationType: "relation_type",
    deletedAt: "deleted_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
  sql: Object.assign(
    vi.fn((s) => ({ raw: s })),
    { join: vi.fn((parts, sep) => ({ parts, sep, op: "join" })) },
  ),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { archiveEntity, restoreEntity } = await import("./archive.js");

const TENANT = "tenant-aaa";
const PARENT_ID = "parent-111";
const CHILD_A = "child-aaa";
const CHILD_B = "child-bbb";
const ARCHIVE_TS = new Date("2026-06-30T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectSeq.length = 0;
  selectCallIndex = 0;
});

// ── archiveEntity ─────────────────────────────────────────────────────────────

describe("archiveEntity", () => {
  it("returns requiresConfirm when ticket has children and confirm=false", async () => {
    // load instance — active
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: null }]);
    // collectActiveDescendants: two children
    mockSelectSeq.push(() => [
      { toInstanceId: CHILD_A },
      { toInstanceId: CHILD_B },
    ]);
    // each child's own children (none)
    mockSelectSeq.push(() => []);
    mockSelectSeq.push(() => []);

    const result = await archiveEntity(dbMock as never, TENANT, PARENT_ID);

    expect(result).toMatchObject({ requiresConfirm: true, childCount: 2 });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("archives parent and all descendants when confirm=true", async () => {
    // load instance
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: null }]);
    // collectActiveDescendants: two children
    mockSelectSeq.push(() => [
      { toInstanceId: CHILD_A },
      { toInstanceId: CHILD_B },
    ]);
    mockSelectSeq.push(() => []); // CHILD_A has no children
    mockSelectSeq.push(() => []); // CHILD_B has no children

    const result = await archiveEntity(
      dbMock as never,
      TENANT,
      PARENT_ID,
      true,
    );

    expect(result).toMatchObject({ archived: true, count: 3 });
    // Three update calls: instances, in-tree relations, and the archived
    // root's own inbound parent_of relation (IMP-5).
    expect(dbMock.update).toHaveBeenCalledTimes(3);
  });

  it("archives a ticket with no children without requiring confirm", async () => {
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: null }]);
    mockSelectSeq.push(() => []); // no children

    const result = await archiveEntity(dbMock as never, TENANT, PARENT_ID);

    expect(result).toMatchObject({ archived: true, count: 1 });
    expect(dbMock.update).toHaveBeenCalledTimes(3);
  });

  it("soft-deletes the archived root's own inbound parent_of relation (IMP-5)", async () => {
    // Reproduces the bug: without this third update, the parent's
    // parent_of -> archivedRoot row survives, and countActiveChildren on
    // the parent permanently counts the archived child as active.
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: null }]);
    mockSelectSeq.push(() => []); // no descendants

    await archiveEntity(dbMock as never, TENANT, PARENT_ID, true);

    expect(dbMock.update).toHaveBeenCalledTimes(3);
    const thirdCallArgs = mockUpdateWhere.mock.calls[2]?.[0] as {
      args: unknown[];
    };
    const flatArgs = JSON.stringify(thirdCallArgs);
    expect(flatArgs).toContain("to_instance_id");
    expect(flatArgs).toContain(PARENT_ID);
    expect(flatArgs).toContain("relation_type");
  });

  it("throws ENTITY_NOT_FOUND when ticket is already archived", async () => {
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: ARCHIVE_TS }]);

    await expect(
      archiveEntity(dbMock as never, TENANT, PARENT_ID),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });

    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("throws ENTITY_NOT_FOUND when ticket does not exist", async () => {
    mockSelectSeq.push(() => []);

    await expect(
      archiveEntity(dbMock as never, TENANT, PARENT_ID),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });
});

// ── restoreEntity ─────────────────────────────────────────────────────────────

describe("restoreEntity", () => {
  it("restores parent and batch descendants (matching deleted_at)", async () => {
    // load instance — archived
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: ARCHIVE_TS }]);
    // collectBatchDescendants: two children with same deletedAt
    mockSelectSeq.push(() => [
      { toInstanceId: CHILD_A },
      { toInstanceId: CHILD_B },
    ]);
    // both inst checks happen in same for-loop before queue processing
    mockSelectSeq.push(() => [{ deletedAt: ARCHIVE_TS }]); // CHILD_A inst check
    mockSelectSeq.push(() => [{ deletedAt: ARCHIVE_TS }]); // CHILD_B inst check
    // then queue processes each child's own children
    mockSelectSeq.push(() => []); // CHILD_A's children (none)
    mockSelectSeq.push(() => []); // CHILD_B's children (none)

    const result = await restoreEntity(dbMock as never, TENANT, PARENT_ID);

    expect(result).toMatchObject({ restored: true, count: 3 });
    // Three update calls: instances, in-tree relations, and the restored
    // root's own inbound parent_of relation (mirrors archiveEntity's IMP-5 fix).
    expect(dbMock.update).toHaveBeenCalledTimes(3);
  });

  it("restores the archived root's own inbound parent_of relation, not just in-tree relations", async () => {
    // Reproduces the bug: without the third update, restoring a mid-tree
    // node left its parent's parent_of -> restoredRoot row still soft-deleted,
    // making the relation graph asymmetric after archive-then-restore.
    mockSelectSeq.push(() => [{ id: CHILD_A, deletedAt: ARCHIVE_TS }]);
    mockSelectSeq.push(() => []); // no batch descendants of CHILD_A

    await restoreEntity(dbMock as never, TENANT, CHILD_A);

    expect(dbMock.update).toHaveBeenCalledTimes(3);
    const thirdCallArgs = mockUpdateWhere.mock.calls[2]?.[0] as {
      args: unknown[];
    };
    const flatArgs = JSON.stringify(thirdCallArgs);
    expect(flatArgs).toContain("to_instance_id");
    expect(flatArgs).toContain(CHILD_A);
    expect(flatArgs).toContain("relation_type");
  });

  it("does not restore descendants archived at a different time", async () => {
    const OTHER_TS = new Date("2026-05-01T00:00:00Z");
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: ARCHIVE_TS }]);
    // collectBatchDescendants: child has different deleted_at → excluded
    mockSelectSeq.push(() => [{ toInstanceId: CHILD_A }]);
    mockSelectSeq.push(() => [{ deletedAt: OTHER_TS }]); // different batch

    const result = await restoreEntity(dbMock as never, TENANT, PARENT_ID);

    // Only the parent itself is restored
    expect(result).toMatchObject({ restored: true, count: 1 });
  });

  it("throws ENTITY_NOT_FOUND when ticket is not archived", async () => {
    mockSelectSeq.push(() => [{ id: PARENT_ID, deletedAt: null }]);

    await expect(
      restoreEntity(dbMock as never, TENANT, PARENT_ID),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });

  it("throws ENTITY_NOT_FOUND when ticket does not exist", async () => {
    mockSelectSeq.push(() => []);

    await expect(
      restoreEntity(dbMock as never, TENANT, PARENT_ID),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });
});
