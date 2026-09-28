import { describe, it, expect, vi, beforeEach } from "vitest";
import { EntityError } from "./errors.js";

// ── Mock @platform/db ─────────────────────────────────────────────────────────

const mockInsertReturning = vi.fn();
const mockUpdateReturning = vi.fn();
const mockSelectResult = vi.fn();
const mockUpdateWhere = vi.fn();
const mockDeleteWhere = vi.fn();

function makeQueryBuilder(finalResult: () => unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["orderBy"] = () => q;
  q["limit"] = () => q;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(finalResult()).then(resolve);
  return q;
}

const dbMock = {
  select: vi.fn(() => makeQueryBuilder(mockSelectResult)),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({ returning: mockInsertReturning })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: (...args: unknown[]) => {
        mockUpdateWhere(...args);
        return { returning: mockUpdateReturning };
      },
    })),
  })),
  delete: vi.fn(() => ({
    where: (...args: unknown[]) => {
      mockDeleteWhere(...args);
      return Promise.resolve([]);
    },
  })),
};

vi.mock("@platform/db", () => ({
  entityTypes: {
    id: "id",
    tenantId: "tenant_id",
    name: "name",
    moduleId: "module_id",
  },
  entityInstances: {
    entityTypeId: "entity_type_id",
    tenantId: "tenant_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  count: vi.fn(() => ({ op: "count" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
  gt: vi.fn((col, val) => ({ col, val, op: "gt" })),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// createEntityType now auto-seeds a required "title" field via
// addEntityField (mandatory-ticket-fields sync, 2026-09-21) -- that pulls in
// engine.ts's full dependency graph (schema cache, reserved-name checks,
// etc.), well beyond what this narrow unit test mocks. Mock addEntityField
// itself at the module boundary rather than its transitive dependencies.
const mockAddEntityField = vi.fn().mockResolvedValue({});
vi.mock("./engine.js", () => ({
  addEntityField: (...args: unknown[]) => mockAddEntityField(...args),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────

const {
  createEntityType,
  getEntityType,
  listEntityTypes,
  updateEntityType,
  deleteEntityType,
} = await import("./entity-types.js");

const TENANT_ID = "tenant-aaa";
const TYPE_ID = "type-bbb";

const fakeEntityType = {
  id: TYPE_ID,
  tenantId: TENANT_ID,
  name: "ticket",
  plural: "tickets",
  icon: null,
  moduleId: null,
  allowCustomFields: true,
  createdAt: new Date(),
};

describe("createEntityType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddEntityField.mockResolvedValue({});
  });

  it("creates an entity type and returns it", async () => {
    mockInsertReturning.mockResolvedValue([fakeEntityType]);
    const result = await createEntityType(dbMock as never, TENANT_ID, {
      name: "ticket",
      plural: "tickets",
    });
    expect(result.id).toBe(TYPE_ID);
    expect(result.name).toBe("ticket");
  });

  // Mandatory-ticket-fields sync, 2026-09-21 -- every new, per-tenant entity
  // type must have at least a required "title" field guaranteed from
  // creation, not left to the admin's separate, optional "add fields" step.
  it("auto-seeds a required 'title' field for a per-tenant entity type", async () => {
    mockInsertReturning.mockResolvedValue([fakeEntityType]);
    await createEntityType(dbMock as never, TENANT_ID, {
      name: "ticket",
      plural: "tickets",
    });
    expect(mockAddEntityField).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      TYPE_ID,
      expect.objectContaining({
        name: "title",
        isRequired: true,
        isSystem: false,
      }),
    );
  });

  // Team-assign sync, 2026-09-21 (docs/specs/team-assign-oncall-fallback.md
  // R2) -- every new, per-tenant entity type must have an optional team_id
  // field guaranteed from creation, alongside the required title field.
  it("auto-seeds an optional 'team_id' field for a per-tenant entity type", async () => {
    mockInsertReturning.mockResolvedValue([fakeEntityType]);
    await createEntityType(dbMock as never, TENANT_ID, {
      name: "ticket",
      plural: "tickets",
    });
    expect(mockAddEntityField).toHaveBeenCalledWith(
      dbMock,
      TENANT_ID,
      TYPE_ID,
      expect.objectContaining({
        name: "team_id",
        isRequired: false,
        isSystem: false,
      }),
    );
  });

  // /review finding, 2026-09-21 -- addEntityField itself enforces
  // allowCustomFields (engine.ts, CUSTOM_FIELDS_NOT_ALLOWED) and would throw
  // if the auto-seed unconditionally called it, turning a locked-down
  // entity type's creation into a hard failure.
  it("does not auto-seed title or team_id for an entity type created with allowCustomFields: false", async () => {
    mockInsertReturning.mockResolvedValue([
      { ...fakeEntityType, allowCustomFields: false },
    ]);
    const result = await createEntityType(dbMock as never, TENANT_ID, {
      name: "ticket",
      plural: "tickets",
      allowCustomFields: false,
    });
    expect(result.id).toBe(TYPE_ID);
    expect(mockAddEntityField).not.toHaveBeenCalled();
  });

  it("creates a system-level type when tenantId is null", async () => {
    mockInsertReturning.mockResolvedValue([
      { ...fakeEntityType, tenantId: null },
    ]);
    const result = await createEntityType(dbMock as never, null, {
      name: "ticket",
      plural: "tickets",
    });
    expect(result.tenantId).toBeNull();
  });

  // Module-catalog entity types (tenantId null) come from seed SQL
  // (modules/*.sql, ADR-004) which defines its own fields explicitly --
  // auto-seeding here would be a second, conflicting source of truth.
  it("does not auto-seed a 'title' field for a module-catalog entity type (tenantId null)", async () => {
    mockInsertReturning.mockResolvedValue([
      { ...fakeEntityType, tenantId: null },
    ]);
    await createEntityType(dbMock as never, null, {
      name: "ticket",
      plural: "tickets",
    });
    expect(mockAddEntityField).not.toHaveBeenCalled();
  });
});

describe("getEntityType", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the entity type when found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    const result = await getEntityType(dbMock as never, TENANT_ID, TYPE_ID);
    expect(result.id).toBe(TYPE_ID);
  });

  it("throws EntityError when not found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      getEntityType(dbMock as never, TENANT_ID, "nonexistent"),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("listEntityTypes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a cursor page of entity types visible to the tenant", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    const page = await listEntityTypes(dbMock as never, TENANT_ID);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.name).toBe("ticket");
    expect(page.nextCursor).toBeNull();
  });

  it("returns empty page when none found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    const page = await listEntityTypes(dbMock as never, TENANT_ID, {
      moduleId: "unknown-module",
    });
    expect(page.data).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("sets nextCursor when more results exist beyond the limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...fakeEntityType,
      id: `type-${i}`,
      createdAt: new Date(Date.now() + i * 1000),
    }));
    dbMock.select.mockReturnValue(makeQueryBuilder(() => rows));
    const page = await listEntityTypes(dbMock as never, TENANT_ID, {
      limit: 2,
    });
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("updateEntityType", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates and returns the entity type", async () => {
    const updated = { ...fakeEntityType, name: "incident" };
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    mockUpdateReturning.mockResolvedValue([updated]);
    const result = await updateEntityType(dbMock as never, TENANT_ID, TYPE_ID, {
      name: "incident",
    });
    expect(result.name).toBe("incident");
  });

  it("repeats the tenant ownership condition on the UPDATE statement itself (#7 belt-and-suspenders)", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    mockUpdateReturning.mockResolvedValue([fakeEntityType]);
    await updateEntityType(dbMock as never, TENANT_ID, TYPE_ID, {
      name: "incident",
    });

    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    const whereArg = mockUpdateWhere.mock.calls[0]?.[0] as {
      op: string;
      args: unknown[];
    };
    expect(whereArg.op).toBe("and");
    // and(eq(id, entityTypeId), or(isNull(tenantId), eq(tenantId, tenantId)))
    expect(whereArg.args[0]).toMatchObject({ op: "eq", val: TYPE_ID });
    expect(whereArg.args[1]).toMatchObject({ op: "or" });
  });

  it("returns existing type unchanged when input is empty", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    const result = await updateEntityType(
      dbMock as never,
      TENANT_ID,
      TYPE_ID,
      {},
    );
    expect(result.id).toBe(TYPE_ID);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("throws EntityError when entity type not found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      updateEntityType(dbMock as never, TENANT_ID, "nonexistent", {
        name: "x",
      }),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("deleteEntityType", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the entity type when no instances exist", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TYPE_ID }]))
      .mockReturnValue(makeQueryBuilder(() => [{ count: 0 }]));
    await expect(
      deleteEntityType(dbMock as never, TENANT_ID, TYPE_ID),
    ).resolves.toBeUndefined();
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });

  it("repeats the tenant ownership condition on the DELETE statement itself (#7 belt-and-suspenders)", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TYPE_ID }]))
      .mockReturnValue(makeQueryBuilder(() => [{ count: 0 }]));
    await deleteEntityType(dbMock as never, TENANT_ID, TYPE_ID);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    const whereArg = mockDeleteWhere.mock.calls[0]?.[0] as {
      op: string;
      args: unknown[];
    };
    expect(whereArg.op).toBe("and");
    expect(whereArg.args[0]).toMatchObject({ op: "eq", val: TYPE_ID });
    expect(whereArg.args[1]).toMatchObject({ op: "or" });
  });

  it("throws ENTITY_TYPE_HAS_INSTANCES when instances exist", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [{ id: TYPE_ID }]))
      .mockReturnValue(makeQueryBuilder(() => [{ count: 3 }]));
    await expect(
      deleteEntityType(dbMock as never, TENANT_ID, TYPE_ID),
    ).rejects.toMatchObject({ code: "ENTITY_TYPE_HAS_INSTANCES" });
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("throws EntityError when entity type not found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      deleteEntityType(dbMock as never, TENANT_ID, "nonexistent"),
    ).rejects.toBeInstanceOf(EntityError);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});
