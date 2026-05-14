import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError, EntityError } from "./errors.js";

// ── Mock @platform/db ─────────────────────────────────────────────────────────

const mockInsertReturning = vi.fn();
const mockUpdateReturning = vi.fn();
const mockDeleteReturning = vi.fn();
const mockSelectFromWhereLimitResult = vi.fn();

function makeQueryBuilder(finalResult: () => unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["orderBy"] = () => q;
  q["limit"] = () => q;
  q["offset"] = () => q;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(finalResult()).then(resolve);
  // Make it thenable as a promise via Symbol.iterator trick — just override .then
  return q;
}

const dbMock = {
  select: vi.fn(() => makeQueryBuilder(mockSelectFromWhereLimitResult)),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      returning: mockInsertReturning,
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: mockUpdateReturning,
      })),
    })),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(() => ({
      returning: mockDeleteReturning,
    })),
  })),
};

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "id",
    tenantId: "tenant_id",
    entityTypeId: "entity_type_id",
    $inferSelect: {},
    $inferInsert: {},
  },
  entityTypes: { id: "id", tenantId: "tenant_id" },
  entityFields: {
    entityTypeId: "entity_type_id",
    tenantId: "tenant_id",
    sortOrder: "sort_order",
  },
  entityRelations: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  desc: vi.fn((col) => ({ col, op: "desc" })),
}));

// ── Mock validation layer ─────────────────────────────────────────────────────

const mockGetValidationSchema = vi.fn();
const mockApplyFormulaFields = vi.fn(
  async (_fields: unknown[], values: Record<string, unknown>) => values,
);

vi.mock("./validation/index.js", () => ({
  getValidationSchema: (...args: unknown[]) => mockGetValidationSchema(...args),
  invalidateSchemaCache: vi.fn(),
  transformZodErrors: vi.fn((err) => err.errors ?? []),
  applyFormulaFields: (...args: unknown[]) => mockApplyFormulaFields(...args),
  buildZodSchema: vi.fn(),
  evaluateFormula: vi.fn(),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/config", () => ({
  env: { REDIS_URL: "redis://localhost:6379" },
}));

// ── Import engine AFTER mocks ─────────────────────────────────────────────────

const { createEntity, getEntity, updateEntity, deleteEntity, listEntities } =
  await import("./engine.js");

const TENANT_ID = "tenant-aaa";
const ENTITY_TYPE_ID = "type-bbb";
const INSTANCE_ID = "instance-ccc";

const fakeEntityType = {
  id: ENTITY_TYPE_ID,
  tenantId: null,
  name: "ticket",
  plural: "tickets",
  icon: null,
  moduleId: null,
  allowCustomFields: true,
  createdAt: new Date(),
};

const fakeInstance = {
  id: INSTANCE_ID,
  entityTypeId: ENTITY_TYPE_ID,
  tenantId: TENANT_ID,
  workflowId: null,
  currentState: "initial",
  fields: { subject: "Test" },
  createdBy: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makePassingSchema(data: Record<string, unknown> = {}) {
  return {
    safeParse: vi.fn((input) => ({
      success: true,
      data: { ...data, ...input },
    })),
  };
}

function makeFailingSchema(errors: object[]) {
  return {
    safeParse: vi.fn(() => ({
      success: false,
      error: { errors },
    })),
  };
}

describe("createEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // loadEntityType query
    mockSelectFromWhereLimitResult.mockReturnValue([fakeEntityType]);
    // loadEntityFields query (second select call)
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeEntityType]))
      .mockReturnValue(makeQueryBuilder(() => []));
    mockGetValidationSchema.mockResolvedValue(
      makePassingSchema({ subject: "Test" }),
    );
    mockInsertReturning.mockResolvedValue([fakeInstance]);
  });

  it("creates an entity when validation passes", async () => {
    const result = await createEntity(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      fields: { subject: "Test" },
    });
    expect(result.id).toBe(INSTANCE_ID);
    expect(result.fields).toMatchObject({ subject: "Test" });
  });

  it("throws ValidationError when schema validation fails", async () => {
    mockGetValidationSchema.mockResolvedValue(
      makeFailingSchema([
        { path: ["subject"], code: "invalid_type", message: "Required" },
      ]),
    );
    await expect(
      createEntity(dbMock as never, TENANT_ID, {
        entityTypeId: ENTITY_TYPE_ID,
        fields: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws EntityError when entity type is not found", async () => {
    // Reset and only mock empty result — loadEntityType returns nothing
    dbMock.select.mockReset();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      createEntity(dbMock as never, TENANT_ID, {
        entityTypeId: "nonexistent",
        fields: {},
      }),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("getEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyFormulaFields.mockImplementation(async (_f, v) => v);
  });

  it("returns the entity when found", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeInstance]))
      .mockReturnValue(makeQueryBuilder(() => []));
    const result = await getEntity(dbMock as never, TENANT_ID, INSTANCE_ID);
    expect(result.id).toBe(INSTANCE_ID);
  });

  it("throws EntityError when not found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      getEntity(dbMock as never, TENANT_ID, "missing-id"),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("updateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeInstance]))
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeEntityType]))
      .mockReturnValue(makeQueryBuilder(() => []));
    mockGetValidationSchema.mockResolvedValue(
      makePassingSchema({ subject: "Updated" }),
    );
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, fields: { subject: "Updated" } },
    ]);
  });

  it("updates fields when partial schema passes", async () => {
    const result = await updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
      fields: { subject: "Updated" },
    });
    expect(result.fields).toMatchObject({ subject: "Updated" });
  });

  it("throws ValidationError when partial field is invalid", async () => {
    mockGetValidationSchema.mockResolvedValue(
      makeFailingSchema([
        { path: ["subject"], code: "too_big", message: "Too long" },
      ]),
    );
    await expect(
      updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
        fields: { subject: "x".repeat(1000) },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws EntityError when entity not found", async () => {
    dbMock.select.mockReset();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      updateEntity(dbMock as never, TENANT_ID, "nonexistent", {
        fields: { subject: "x" },
      }),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("deleteEntity", () => {
  it("resolves when entity is deleted", async () => {
    mockDeleteReturning.mockResolvedValue([{ id: INSTANCE_ID }]);
    await expect(
      deleteEntity(dbMock as never, TENANT_ID, INSTANCE_ID),
    ).resolves.toBeUndefined();
  });

  it("throws EntityError when entity not found", async () => {
    mockDeleteReturning.mockResolvedValue([]);
    await expect(
      deleteEntity(dbMock as never, TENANT_ID, "missing"),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("listEntities", () => {
  it("returns a list of entity instances", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeInstance]));
    const results = await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(INSTANCE_ID);
  });

  it("returns empty array when no matches", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    const results = await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      state: "closed",
    });
    expect(results).toHaveLength(0);
  });
});
