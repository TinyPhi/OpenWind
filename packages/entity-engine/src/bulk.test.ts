import { describe, it, expect, vi, beforeEach } from "vitest";
import { inArray } from "drizzle-orm";
import { entityInstances } from "@platform/db";

// ── Mock @platform/db ─────────────────────────────────────────────────────────

const mockInsertReturning = vi.fn();
const mockUpdateReturning = vi.fn();
const mockSelectResult = vi.fn();

function makeSelectBuilder(result: () => unknown[]) {
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["orderBy"] = () => q;
  q["limit"] = () => q;
  q["then"] = (resolve: (v: unknown[]) => void) =>
    Promise.resolve(result()).then(resolve);
  return q;
}

const dbMock = {
  select: vi.fn(() => makeSelectBuilder(mockSelectResult)),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({ returning: mockInsertReturning })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: mockUpdateReturning })),
    })),
  })),
};

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "id",
    tenantId: "tenant_id",
    entityTypeId: "entity_type_id",
    currentState: "current_state",
    deletedAt: { deleted_at: "deleted_at" },
    $inferSelect: {},
    $inferInsert: {},
  },
  entityTypes: { id: "id" },
  entityFields: {
    entityTypeId: "entity_type_id",
    tenantId: "tenant_id",
    sortOrder: "sort_order",
  },
  entityRelations: {},
  outboxEvents: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
  gt: vi.fn((col, val) => ({ col, val, op: "gt" })),
  desc: vi.fn((col) => ({ col, op: "desc" })),
}));

const mockGetValidationSchema = vi.fn();
const mockApplyFormulaFields = vi.fn(
  async (_fields: unknown[], values: Record<string, unknown>) => values,
);
const mockValidateEntityRefs = vi.fn(async () => []);
const mockValidateUserRefs = vi.fn(async () => []);

vi.mock("./validation/index.js", () => ({
  getValidationSchema: (...args: unknown[]) => mockGetValidationSchema(...args),
  invalidateSchemaCache: vi.fn(),
  transformZodErrors: vi.fn((err) => err.errors ?? []),
  applyFormulaFields: (...args: unknown[]) => mockApplyFormulaFields(...args),
  buildZodSchema: vi.fn(),
  evaluateFormula: vi.fn(),
  validateEntityRefs: (...args: unknown[]) => mockValidateEntityRefs(...args),
  validateUserRefs: (...args: unknown[]) => mockValidateUserRefs(...args),
}));

vi.mock("./lookup-resolver.js", () => ({
  resolveLookupFields: vi.fn(
    async (
      _db: unknown,
      _t: unknown,
      _id: unknown,
      _f: unknown,
      values: Record<string, unknown>,
    ) => values,
  ),
  resolveLookupFieldsBatch: vi.fn(
    async (
      _db: unknown,
      _t: unknown,
      instances: Array<{ id: string; fields: Record<string, unknown> }>,
    ) => new Map(instances.map((i) => [i.id, i.fields])),
  ),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({ status: "close" })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

const { bulkCreateEntities, bulkUpdateEntities, bulkSetState } =
  await import("./engine.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT = "tenant-aaa";
const TYPE_ID = "type-bbb";

const fakeEntityType = {
  id: TYPE_ID,
  tenantId: null,
  name: "ticket",
  plural: "tickets",
  icon: null,
  moduleId: null,
  allowCustomFields: true,
  createdAt: new Date(),
};

function makeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    entityTypeId: TYPE_ID,
    tenantId: TENANT,
    workflowId: null,
    currentState: "initial",
    fields: { subject: "hello" },
    createdBy: null,
    assignedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    searchVector: null,
    ...overrides,
  };
}

function passingSchema(extra: Record<string, unknown> = {}) {
  return {
    safeParse: vi.fn((input: unknown) => ({
      success: true,
      data: { ...(input as Record<string, unknown>), ...extra },
    })),
  };
}

function failingSchema(
  errors = [{ field: "subject", code: "required", message: "required" }],
) {
  return {
    safeParse: vi.fn(() => ({ success: false, error: { errors } })),
  };
}

// ── bulkCreateEntities ────────────────────────────────────────────────────────

describe("bulkCreateEntities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyFormulaFields.mockImplementation(
      async (_f: unknown[], v: Record<string, unknown>) => v,
    );
  });

  it("inserts all valid items in one batch and returns created instances", async () => {
    mockGetValidationSchema.mockResolvedValue(passingSchema());
    mockSelectResult.mockReturnValue([fakeEntityType]);
    const row1 = makeRow("inst-1");
    const row2 = makeRow("inst-2");
    mockInsertReturning.mockResolvedValue([row1, row2]);

    const inputs = [
      { entityTypeId: TYPE_ID, fields: { subject: "A" } },
      { entityTypeId: TYPE_ID, fields: { subject: "B" } },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkCreateEntities(dbMock as any, TENANT, inputs);

    expect(result.created).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    // 1 batch insert into entityInstances + 1 batch insert into outboxEvents
    // (entity.created for both rows, #126)
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it("collects validation errors per item without blocking valid items", async () => {
    mockGetValidationSchema
      .mockResolvedValueOnce(failingSchema())
      .mockResolvedValueOnce(passingSchema());
    mockSelectResult.mockReturnValue([fakeEntityType]);
    mockInsertReturning.mockResolvedValue([makeRow("inst-1")]);

    const inputs = [
      { entityTypeId: TYPE_ID, fields: { subject: "" } },
      { entityTypeId: TYPE_ID, fields: { subject: "B" } },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkCreateEntities(dbMock as any, TENANT, inputs);

    expect(result.created).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(0);
  });

  it("returns empty created and collects all errors when every item fails", async () => {
    mockGetValidationSchema.mockResolvedValue(failingSchema());

    const inputs = [
      { entityTypeId: TYPE_ID, fields: {} },
      { entityTypeId: TYPE_ID, fields: {} },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkCreateEntities(dbMock as any, TENANT, inputs);

    expect(result.created).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("returns empty result for empty input", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkCreateEntities(dbMock as any, TENANT, []);
    expect(result.created).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects items whose entity_ref or user_ref fields point to another tenant", async () => {
    mockGetValidationSchema.mockResolvedValue(passingSchema());
    mockSelectResult.mockReturnValue([fakeEntityType]);
    mockValidateEntityRefs.mockResolvedValueOnce([
      {
        field: "related_id",
        code: "INVALID_REFERENCE",
        message: "Cross-tenant reference",
      },
    ]);
    mockValidateUserRefs.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([makeRow("inst-2")]);

    const inputs = [
      {
        entityTypeId: TYPE_ID,
        fields: { subject: "bad-ref", related_id: "other-tenant-id" },
      },
      { entityTypeId: TYPE_ID, fields: { subject: "B" } },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkCreateEntities(dbMock as any, TENANT, inputs);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(0);
    expect(result.created).toHaveLength(1);
    // 1 batch insert into entityInstances + 1 batch insert into outboxEvents
    // (entity.created for the one valid row, #126)
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });
});

// ── bulkUpdateEntities ────────────────────────────────────────────────────────

describe("bulkUpdateEntities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyFormulaFields.mockImplementation(
      async (_f: unknown[], v: Record<string, unknown>) => v,
    );
  });

  it("updates valid items and returns updated instances", async () => {
    const row = makeRow("inst-1");
    mockSelectResult.mockReturnValue([row, fakeEntityType]);
    mockGetValidationSchema.mockResolvedValue(passingSchema());
    mockUpdateReturning.mockResolvedValue([
      makeRow("inst-1", { fields: { subject: "updated" } }),
    ]);

    const updates = [
      { id: "inst-1", input: { fields: { subject: "updated" } } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkUpdateEntities(dbMock as any, TENANT, updates);

    expect(result.updated).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("records ENTITY_NOT_FOUND error for unknown ids", async () => {
    mockSelectResult.mockReturnValue([]);

    const updates = [{ id: "ghost-id", input: { fields: { subject: "x" } } }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkUpdateEntities(dbMock as any, TENANT, updates);

    expect(result.updated).toHaveLength(0);
    expect(result.errors[0]?.code).toBe("ENTITY_NOT_FOUND");
    expect(result.errors[0]?.id).toBe("ghost-id");
  });

  it("records VALIDATION_ERROR for items with invalid fields", async () => {
    mockSelectResult.mockReturnValue([makeRow("inst-1")]);
    mockGetValidationSchema.mockResolvedValue(failingSchema());

    const updates = [{ id: "inst-1", input: { fields: { subject: "" } } }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkUpdateEntities(dbMock as any, TENANT, updates);

    expect(result.updated).toHaveLength(0);
    expect(result.errors[0]?.code).toBe("VALIDATION_ERROR");
  });

  it("processes items independently — valid items succeed even when others fail", async () => {
    // The existing-rows fetch is now one batched query (#196) — only inst-2
    // exists, so it's the only row the batch returns; ghost-id resolves to
    // ENTITY_NOT_FOUND via the resulting Map having no entry for it, not via
    // a separate per-item query.
    mockSelectResult
      .mockReturnValueOnce([makeRow("inst-2")]) // batched existing-rows fetch
      .mockReturnValueOnce([fakeEntityType]); // inst-2's loadEntityType call
    mockGetValidationSchema.mockResolvedValue(passingSchema());
    mockUpdateReturning.mockResolvedValue([makeRow("inst-2")]);

    const updates = [
      { id: "ghost-id", input: { fields: { subject: "x" } } },
      { id: "inst-2", input: { fields: { subject: "y" } } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkUpdateEntities(dbMock as any, TENANT, updates);

    expect(result.updated).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("ENTITY_NOT_FOUND");
  });

  it("fetches all existing rows in a single batched query, not one per item (#196)", async () => {
    // The first select() call (issued synchronously before the per-item
    // Promise.all starts) is the batched existing-rows fetch; everything
    // after runs concurrently per item (loadEntityType/loadEntityFields),
    // so only the first call's shape is asserted precisely here — the
    // distinguishing signal of this fix is that it's an inArray query
    // covering both ids in one round trip, not two separate eq(id, ...)
    // round trips (the pre-fix N+1 shape).
    mockSelectResult.mockReturnValue([makeRow("inst-1"), makeRow("inst-2")]);
    mockGetValidationSchema.mockResolvedValue(passingSchema());
    mockUpdateReturning
      .mockResolvedValueOnce([makeRow("inst-1")])
      .mockResolvedValueOnce([makeRow("inst-2")]);

    const updates = [
      { id: "inst-1", input: { fields: { subject: "a" } } },
      { id: "inst-2", input: { fields: { subject: "b" } } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkUpdateEntities(dbMock as any, TENANT, updates);

    expect(result.updated).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(inArray).toHaveBeenCalledWith(
      entityInstances.id,
      expect.arrayContaining(["inst-1", "inst-2"]),
    );
  });
});

// ── bulkSetState ──────────────────────────────────────────────────────────────

describe("bulkSetState", () => {
  beforeEach(() => vi.clearAllMocks());

  it("batch-updates state and returns updated ids", async () => {
    mockSelectResult.mockReturnValue([{ id: "inst-1" }, { id: "inst-2" }]);
    mockUpdateReturning.mockResolvedValue([{ id: "inst-1" }, { id: "inst-2" }]);

    const items = [
      { id: "inst-1", state: "open" },
      { id: "inst-2", state: "open" },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkSetState(dbMock as any, TENANT, items);

    expect(result.updatedIds).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    // one UPDATE for the shared "open" state
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("issues one UPDATE per unique target state", async () => {
    mockSelectResult.mockReturnValue([
      { id: "inst-1" },
      { id: "inst-2" },
      { id: "inst-3" },
    ]);
    mockUpdateReturning
      .mockResolvedValueOnce([{ id: "inst-1" }])
      .mockResolvedValueOnce([{ id: "inst-2" }, { id: "inst-3" }]);

    const items = [
      { id: "inst-1", state: "closed" },
      { id: "inst-2", state: "open" },
      { id: "inst-3", state: "open" },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkSetState(dbMock as any, TENANT, items);

    expect(result.updatedIds).toHaveLength(3);
    expect(dbMock.update).toHaveBeenCalledTimes(2);
  });

  it("records ENTITY_NOT_FOUND for ids not owned by the tenant", async () => {
    mockSelectResult.mockReturnValue([{ id: "inst-1" }]); // inst-2 not returned

    const items = [
      { id: "inst-1", state: "open" },
      { id: "inst-2", state: "open" },
    ];
    mockUpdateReturning.mockResolvedValue([{ id: "inst-1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkSetState(dbMock as any, TENANT, items);

    expect(result.updatedIds).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe("inst-2");
    expect(result.errors[0]?.code).toBe("ENTITY_NOT_FOUND");
  });

  it("returns empty result for empty input without hitting the db", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await bulkSetState(dbMock as any, TENANT, []);
    expect(result.updatedIds).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});
