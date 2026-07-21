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

const mockInsertValues = vi.fn(() => ({
  returning: mockInsertReturning,
}));

const dbMock = {
  select: vi.fn(() => makeQueryBuilder(mockSelectFromWhereLimitResult)),
  insert: vi.fn((table: unknown) => ({
    values: (rows: unknown) => mockInsertValues(table, rows),
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
    currentState: "current_state",
    assignedTo: "assigned_to",
    deletedAt: { deleted_at: "deleted_at" },
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
  outboxEvents: {},
  workflowEvents: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  desc: vi.fn((col) => ({ col, op: "desc" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
  gt: vi.fn((col, val) => ({ col, val, op: "gt" })),
  inArray: vi.fn((col, vals) => ({ col, vals, op: "inArray" })),
  sql: vi.fn((..._args: unknown[]) => ({ op: "sql" })),
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
  // validateEntityRefs — default no-op (returns no errors); individual tests can
  // override via mockResolvedValueOnce to exercise the rejection path.
  validateEntityRefs: vi.fn().mockResolvedValue([]),
  validateUserRefs: vi.fn().mockResolvedValue([]),
  isSafeRegex: vi.fn().mockResolvedValue(true),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({ status: "close" })),
}));

// ── Import engine AFTER mocks ─────────────────────────────────────────────────

const {
  createEntity,
  getEntity,
  updateEntity,
  deleteEntity,
  listEntities,
  setEntityState,
  bulkSetState,
  addEntityField,
} = await import("./engine.js");

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
  deletedAt: null,
};

const fakeSoftDeletedInstance = { ...fakeInstance, deletedAt: new Date() };

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

  it("throws EntityError for a soft-deleted entity", async () => {
    // The isNull(deletedAt) filter means the DB returns no rows for deleted instances
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      getEntity(dbMock as never, TENANT_ID, INSTANCE_ID),
    ).rejects.toBeInstanceOf(EntityError);
  });

  it("exposes deletedAt as null on active instances", async () => {
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeInstance]))
      .mockReturnValue(makeQueryBuilder(() => []));
    const result = await getEntity(dbMock as never, TENANT_ID, INSTANCE_ID);
    expect(result.deletedAt).toBeNull();
  });
});

describe("updateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeInstance]))
      // isChildTicket check against entity_relations — empty means "not a
      // child ticket", so the full-schema validation path below still runs.
      .mockReturnValueOnce(makeQueryBuilder(() => []))
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

  it("throws EntityError when entity is soft-deleted", async () => {
    // isNull(deletedAt) in the WHERE means soft-deleted rows return empty
    dbMock.select.mockReset();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
        fields: { subject: "x" },
      }),
    ).rejects.toBeInstanceOf(EntityError);
  });

  it("feeds the zod-coerced fullResult.data to applyFormulaFields, not the raw merged object", async () => {
    const partialSchema = makePassingSchema();
    const fullSchema = {
      safeParse: vi.fn(() => ({
        success: true,
        // coercedFlag only appears here — never in the raw merged object —
        // so its presence in applyFormulaFields' input proves fullResult.data
        // was used, not the pre-validation merge.
        data: { subject: "Updated", coercedFlag: true },
      })),
    };
    mockGetValidationSchema
      .mockResolvedValueOnce(partialSchema)
      .mockResolvedValueOnce(fullSchema);

    await updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
      fields: { subject: "Updated" },
    });

    expect(mockApplyFormulaFields).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ coercedFlag: true }),
    );
  });

  it("still runs full validation for an entity type whose fields happen to include a child_status string (not an actual child ticket)", async () => {
    // Previously isChildTicket was a heuristic on `fields.child_status` being
    // a string — any unrelated entity type using that field name would
    // silently skip full-schema/cross-field validation. Now it's a real
    // entity_relations lookup, so this case must NOT skip validation.
    const instanceWithChildStatusField = {
      ...fakeInstance,
      fields: { subject: "Test", child_status: "open" },
    };
    dbMock.select.mockReset();
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [instanceWithChildStatusField]),
      )
      // entity_relations child_of check — no real relation exists
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeEntityType]))
      .mockReturnValue(makeQueryBuilder(() => []));
    mockGetValidationSchema
      .mockResolvedValueOnce(makePassingSchema())
      .mockResolvedValueOnce(
        makeFailingSchema([
          {
            path: ["required_field"],
            code: "invalid_type",
            message: "Required",
          },
        ]),
      );

    await expect(
      updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
        fields: { subject: "Updated" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("deleteEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("soft-deletes by setting deleted_at rather than removing the row", async () => {
    // UPDATE...RETURNING returns the pre-deletion row; SELECT is only used for
    // loadEntityType / loadEntityFields after the update.
    mockUpdateReturning.mockResolvedValue([fakeInstance]);
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    await expect(
      deleteEntity(dbMock as never, TENANT_ID, INSTANCE_ID),
    ).resolves.toBeUndefined();
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("throws EntityError when entity not found", async () => {
    // UPDATE...RETURNING returns [] when the WHERE clause matches no rows
    mockUpdateReturning.mockResolvedValue([]);
    await expect(
      deleteEntity(dbMock as never, TENANT_ID, "missing"),
    ).rejects.toBeInstanceOf(EntityError);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("throws EntityError when entity is already soft-deleted", async () => {
    // isNull(deletedAt) in the WHERE clause means already-deleted rows return []
    mockUpdateReturning.mockResolvedValue([]);
    await expect(
      deleteEntity(dbMock as never, TENANT_ID, INSTANCE_ID),
    ).rejects.toBeInstanceOf(EntityError);
  });
});

describe("setEntityState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the state and returns the updated instance", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [{ id: INSTANCE_ID }]),
    );
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, currentState: "closed" },
    ]);

    const result = await setEntityState(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
      "closed",
    );

    expect(result.currentState).toBe("closed");
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("throws EntityError when the entity does not exist", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));

    await expect(
      setEntityState(dbMock as never, TENANT_ID, "missing-id", "open"),
    ).rejects.toBeInstanceOf(EntityError);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("throws EntityError for a soft-deleted entity (isNull filter returns empty)", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));

    await expect(
      setEntityState(dbMock as never, TENANT_ID, INSTANCE_ID, "open"),
    ).rejects.toBeInstanceOf(EntityError);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  // #127 — setEntityState was a silent state side-door: it wrote current_state
  // directly with no workflow_events row and no outbox event, so the change
  // never appeared in the workflow audit trail and never triggered automations.
  it("writes a workflow_events row and a workflow.transitioned outbox event when the entity has a workflow (#127)", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [
        {
          id: INSTANCE_ID,
          entityTypeId: ENTITY_TYPE_ID,
          currentState: "open",
          workflowId: "wf-1",
        },
      ]),
    );
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, currentState: "closed", workflowId: "wf-1" },
    ]);

    await setEntityState(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
      "closed",
      "actor-1",
    );

    const insertedTables = mockInsertValues.mock.calls.map(([table]) => table);
    const dbModule = await import("@platform/db");
    expect(insertedTables).toContain(dbModule.workflowEvents);
    expect(insertedTables).toContain(dbModule.outboxEvents);

    const workflowEventCall = mockInsertValues.mock.calls.find(
      ([table]) => table === dbModule.workflowEvents,
    );
    expect(workflowEventCall?.[1]).toMatchObject({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      workflowId: "wf-1",
      fromState: "open",
      toState: "closed",
      actorId: "actor-1",
    });

    const outboxCall = mockInsertValues.mock.calls.find(
      ([table]) => table === dbModule.outboxEvents,
    );
    expect(outboxCall?.[1]).toMatchObject({
      tenantId: TENANT_ID,
      eventType: "workflow.transitioned",
      payload: expect.objectContaining({
        eventType: "workflow.transitioned",
        instanceId: INSTANCE_ID,
        fromState: "open",
        toState: "closed",
        actorId: "actor-1",
      }),
    });
  });

  it("does not write workflow_events/outbox when the entity has no workflowId", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [
        {
          id: INSTANCE_ID,
          entityTypeId: ENTITY_TYPE_ID,
          currentState: "open",
          workflowId: null,
        },
      ]),
    );
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, currentState: "closed", workflowId: null },
    ]);

    await setEntityState(dbMock as never, TENANT_ID, INSTANCE_ID, "closed");

    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

describe("bulkSetState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #127 — bulkSetState had the identical unguarded side-door as setEntityState.
  it("writes a workflow_events row and outbox event per changed instance with a workflow (#127)", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [
        {
          id: INSTANCE_ID,
          entityTypeId: ENTITY_TYPE_ID,
          currentState: "open",
          workflowId: "wf-1",
        },
      ]),
    );
    mockUpdateReturning.mockResolvedValue([{ id: INSTANCE_ID }]);

    const result = await bulkSetState(
      dbMock as never,
      TENANT_ID,
      [{ id: INSTANCE_ID, state: "closed" }],
      "actor-1",
    );

    expect(result.updatedIds).toEqual([INSTANCE_ID]);

    const dbModule = await import("@platform/db");
    const insertedTables = mockInsertValues.mock.calls.map(([table]) => table);
    expect(insertedTables).toContain(dbModule.workflowEvents);
    expect(insertedTables).toContain(dbModule.outboxEvents);

    const workflowEventCall = mockInsertValues.mock.calls.find(
      ([table]) => table === dbModule.workflowEvents,
    );
    expect(workflowEventCall?.[1]).toEqual([
      expect.objectContaining({
        tenantId: TENANT_ID,
        instanceId: INSTANCE_ID,
        workflowId: "wf-1",
        fromState: "open",
        toState: "closed",
        actorId: "actor-1",
      }),
    ]);
  });

  it("skips instances with no workflowId or an unchanged state", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [
        {
          id: INSTANCE_ID,
          entityTypeId: ENTITY_TYPE_ID,
          currentState: "open",
          workflowId: null,
        },
      ]),
    );
    mockUpdateReturning.mockResolvedValue([{ id: INSTANCE_ID }]);

    await bulkSetState(
      dbMock as never,
      TENANT_ID,
      [{ id: INSTANCE_ID, state: "closed" }],
      "actor-1",
    );

    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

describe("addEntityField", () => {
  const fakeField = {
    id: "field-1",
    entityTypeId: ENTITY_TYPE_ID,
    tenantId: TENANT_ID,
    name: "priority",
    label: "Priority",
    fieldType: "text" as const,
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    createdAt: new Date(),
  };

  const fieldInput = {
    entityTypeId: ENTITY_TYPE_ID,
    name: "priority",
    label: "Priority",
    fieldType: "text" as const,
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    createdAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts the field, invalidates schema cache, and returns the new field", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    mockInsertReturning.mockResolvedValue([fakeField]);
    const { invalidateSchemaCache } = await import("./validation/index.js");

    const result = await addEntityField(
      dbMock as never,
      TENANT_ID,
      ENTITY_TYPE_ID,
      fieldInput,
    );

    expect(result.name).toBe("priority");
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(invalidateSchemaCache).toHaveBeenCalledWith(
      ENTITY_TYPE_ID,
      TENANT_ID,
    );
  });

  it("throws EntityError when the entity type is not found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));

    await expect(
      addEntityField(dbMock as never, TENANT_ID, "nonexistent", fieldInput),
    ).rejects.toBeInstanceOf(EntityError);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("throws EntityError when the entity type forbids custom fields", async () => {
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [
        { ...fakeEntityType, tenantId: TENANT_ID, allowCustomFields: false },
      ]),
    );

    await expect(
      addEntityField(dbMock as never, TENANT_ID, ENTITY_TYPE_ID, fieldInput),
    ).rejects.toBeInstanceOf(EntityError);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe("listEntities", () => {
  it("returns a cursor page of entity instances", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeInstance]));
    const page = await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.id).toBe(INSTANCE_ID);
    expect(page.nextCursor).toBeNull();
  });

  it("returns empty page when no matches", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    const page = await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      state: "closed",
    });
    expect(page.data).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("sets nextCursor when more results exist beyond the limit", async () => {
    // Return limit+1 rows to trigger hasMore
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...fakeInstance,
      id: `instance-${i}`,
      createdAt: new Date(Date.now() + i * 1000),
    }));
    dbMock.select.mockReturnValue(makeQueryBuilder(() => rows));
    const page = await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      limit: 2,
    });
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("adds isNull(deletedAt) filter by default", async () => {
    const { isNull } = await import("drizzle-orm");
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
    });
    expect(isNull).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: "deleted_at" }),
    );
  });

  it("omits isNull filter when includeDeleted is true", async () => {
    const { isNull } = await import("drizzle-orm");
    vi.mocked(isNull).mockClear();
    dbMock.select.mockReturnValue(
      makeQueryBuilder(() => [fakeSoftDeletedInstance]),
    );
    const page = await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      includeDeleted: true,
    });
    // isNull is called for entity-field tenant scoping — but must NOT be
    // called with deletedAt, which would incorrectly filter deleted entities
    expect(isNull).not.toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: "deleted_at" }),
    );
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.deletedAt).not.toBeNull();
  });

  it("filters by assignedTo when provided", async () => {
    const { eq } = await import("drizzle-orm");
    vi.mocked(eq).mockClear();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeInstance]));

    await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      assignedTo: "user-xyz",
    });

    expect(eq).toHaveBeenCalledWith(expect.anything(), "user-xyz");
  });

  it("applies JSONB containment filter when fieldFilters is provided", async () => {
    const { sql } = await import("drizzle-orm");
    vi.mocked(sql).mockClear();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeInstance]));

    await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      fieldFilters: { priority: "high" },
    });

    expect(sql).toHaveBeenCalled();
  });

  it("skips JSONB filter when fieldFilters is an empty object", async () => {
    const { sql } = await import("drizzle-orm");
    vi.mocked(sql).mockClear();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));

    await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      fieldFilters: {},
    });

    expect(sql).not.toHaveBeenCalled();
  });
});
