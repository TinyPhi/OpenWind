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

const mockExecute = vi.fn().mockResolvedValue([]);

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
  execute: (...args: unknown[]) => mockExecute(...args),
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
  workflowStates: { workflowId: "workflow_id", name: "name" },
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
  dueDate: null,
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

describe("updateEntity — dueDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [fakeInstance]))
      // getParentId — not a child ticket
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      .mockReturnValue(makeQueryBuilder(() => []));
  });

  it("schedules an entity.due_date_scheduled outbox event when dueDate is set", async () => {
    const dueDate = "2026-06-01T00:00:00.000Z";
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, dueDate: new Date(dueDate) },
    ]);

    await updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, { dueDate });

    // Supersedes any prior pending schedule for this instance first.
    expect(mockExecute).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "entity.due_date_scheduled",
        payload: expect.objectContaining({
          eventType: "entity.due_date_scheduled",
          instanceId: INSTANCE_ID,
          dueDate,
        }),
      }),
    );
  });

  it("supersedes the pending schedule but writes no new one when dueDate is cleared", async () => {
    const instanceWithDueDate = {
      ...fakeInstance,
      dueDate: new Date("2026-06-01T00:00:00.000Z"),
    };
    dbMock.select.mockReset();
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [instanceWithDueDate]))
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      .mockReturnValue(makeQueryBuilder(() => []));
    mockUpdateReturning.mockResolvedValue([{ ...fakeInstance, dueDate: null }]);

    await updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
      dueDate: null,
    });

    expect(mockExecute).toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "entity.due_date_scheduled" }),
    );
  });

  it("does not touch the schedule when dueDate is not provided", async () => {
    mockUpdateReturning.mockResolvedValue([fakeInstance]);

    await updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, {
      assignedTo: "user-1",
    });

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("is a no-op when the new dueDate equals the existing one", async () => {
    const dueDate = "2026-06-01T00:00:00.000Z";
    const instanceWithDueDate = {
      ...fakeInstance,
      dueDate: new Date(dueDate),
    };
    dbMock.select.mockReset();
    dbMock.select
      .mockReturnValueOnce(makeQueryBuilder(() => [instanceWithDueDate]))
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      .mockReturnValue(makeQueryBuilder(() => []));
    mockUpdateReturning.mockResolvedValue([instanceWithDueDate]);

    await updateEntity(dbMock as never, TENANT_ID, INSTANCE_ID, { dueDate });

    expect(mockExecute).not.toHaveBeenCalled();
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
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-1",
          },
        ]),
      )
      // #160 — getParentId (not a child ticket: empty result).
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      // #160 — the new workflow_states validation query.
      .mockReturnValueOnce(makeQueryBuilder(() => [{ name: "closed" }]))
      // Remaining calls are loadEntityType/loadEntityFields (audit hook,
      // run via Promise.all after the update) — any truthy row satisfies both.
      .mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
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

  // #160 — setEntityState previously accepted any state string with no check
  // against the workflow's actual workflow_states, unlike updateEntity.
  it("rejects a state that is not a valid workflow_states name for the entity's workflow (#160)", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-1",
          },
        ]),
      )
      // getParentId (not a child ticket).
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ name: "open" }, { name: "closed" }]),
      );

    await expect(
      setEntityState(dbMock as never, TENANT_ID, INSTANCE_ID, "bogus"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("accepts a state that IS a valid workflow_states name for the entity's workflow (#160)", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-1",
          },
        ]),
      )
      // getParentId (not a child ticket).
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ name: "open" }, { name: "closed" }]),
      )
      // loadEntityType/loadEntityFields (audit hook) — any truthy row works.
      .mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, currentState: "closed", workflowId: "wf-1" },
    ]);

    const result = await setEntityState(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
      "closed",
    );

    expect(result.currentState).toBe("closed");
  });

  // #160 — a child ticket inherits its parent's workflowId, so without a
  // child-ticket-aware check it would validate against the PARENT's full
  // workflow_states instead of the fixed open/in-progress/closed set
  // updateEntity already restricts children to.
  it("restricts a child ticket to open/in-progress/closed regardless of the parent workflow's states (#160)", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-parent",
          },
        ]),
      )
      // getParentId — IS a child ticket.
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ toInstanceId: "parent-1" }]),
      );

    await expect(
      setEntityState(
        dbMock as never,
        TENANT_ID,
        INSTANCE_ID,
        "boq_preparation", // a real state in the parent's workflow, invalid for children
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("allows a child ticket to be set to a state in its fixed set (#160)", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-parent",
          },
        ]),
      )
      // getParentId — IS a child ticket.
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ toInstanceId: "parent-1" }]),
      )
      .mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    mockUpdateReturning.mockResolvedValue([
      { ...fakeInstance, currentState: "in-progress", workflowId: "wf-parent" },
    ]);

    const result = await setEntityState(
      dbMock as never,
      TENANT_ID,
      INSTANCE_ID,
      "in-progress",
    );

    expect(result.currentState).toBe("in-progress");
  });
});

describe("bulkSetState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #127 — bulkSetState had the identical unguarded side-door as setEntityState.
  it("writes a workflow_events row and outbox event per changed instance with a workflow (#127)", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-1",
          },
        ]),
      )
      // #160 — batched entity_relations lookup (no child tickets in batch).
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      // #160 — the new workflow_states validation query.
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ workflowId: "wf-1", name: "closed" }]),
      )
      // loadEntityType/loadEntityFields (audit hook loop) — any truthy row.
      .mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
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

  // #160 — bulkSetState previously accepted any state string with no check,
  // and (per the design risk this test locks in) must validate each item
  // against ITS OWN workflow, not a single flat set of "valid states seen
  // anywhere in this batch" — two items in different workflows targeting the
  // same state string must be judged independently.
  it("validates each item against its OWN workflow, not a batch-wide state set (#160)", async () => {
    const ID_A = "instance-a";
    const ID_B = "instance-b";
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: ID_A,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-a",
          },
          {
            id: ID_B,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-b",
          },
        ]),
      )
      // #160 — batched entity_relations lookup (no child tickets in batch).
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      // "closed" is valid in wf-a but NOT in wf-b.
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          { workflowId: "wf-a", name: "open" },
          { workflowId: "wf-a", name: "closed" },
          { workflowId: "wf-b", name: "open" },
          { workflowId: "wf-b", name: "in-review" },
        ]),
      )
      // loadEntityType/loadEntityFields (audit hook loop, for ID_A only —
      // ID_B is rejected before reaching the update/audit path) — any
      // truthy row works.
      .mockReturnValue(makeQueryBuilder(() => [fakeEntityType]));
    mockUpdateReturning.mockResolvedValue([{ id: ID_A }]);

    const result = await bulkSetState(
      dbMock as never,
      TENANT_ID,
      [
        { id: ID_A, state: "closed" },
        { id: ID_B, state: "closed" },
      ],
      "actor-1",
    );

    expect(result.updatedIds).toEqual([ID_A]);
    expect(result.errors).toEqual([
      { index: 1, id: ID_B, code: "INVALID_STATE" },
    ]);
  });

  // #160 — a child ticket in a bulk batch must be restricted to
  // open/in-progress/closed, even though it inherits its parent's full
  // workflowId (same mirror of updateEntity's child-ticket check as the
  // single-item setEntityState path above).
  it("restricts a child ticket in the batch to open/in-progress/closed (#160)", async () => {
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: INSTANCE_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-parent",
          },
        ]),
      )
      // entity_relations — INSTANCE_ID IS a child ticket.
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ fromInstanceId: INSTANCE_ID }]),
      );

    const result = await bulkSetState(
      dbMock as never,
      TENANT_ID,
      [{ id: INSTANCE_ID, state: "boq_preparation" }],
      "actor-1",
    );

    expect(result.updatedIds).toEqual([]);
    expect(result.errors).toEqual([
      { index: 0, id: INSTANCE_ID, code: "INVALID_STATE" },
    ]);
  });

  // #160 — regression guard for a real bug an adversarial review caught:
  // indexing INVALID_STATE errors by an id->index Map collapses to the LAST
  // occurrence when the same id appears twice in one batch, misreporting an
  // earlier occurrence's error at the wrong index. Each validItems entry now
  // carries its own originalIndex captured at the first pass over `items`,
  // so duplicate ids can't collide.
  it("reports the correct original index for each occurrence when an id is duplicated in the batch (#160)", async () => {
    const DUP_ID = "instance-dup";
    const OTHER_ID = "instance-other";
    dbMock.select
      .mockReturnValueOnce(
        makeQueryBuilder(() => [
          {
            id: DUP_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-1",
          },
          {
            id: OTHER_ID,
            entityTypeId: ENTITY_TYPE_ID,
            currentState: "open",
            workflowId: "wf-1",
          },
        ]),
      )
      // entity_relations — no child tickets.
      .mockReturnValueOnce(makeQueryBuilder(() => []))
      // "open" is the only valid state — every "closed"/"bogus" target below
      // is invalid, isolating the index-tracking behavior from state validity.
      .mockReturnValueOnce(
        makeQueryBuilder(() => [{ workflowId: "wf-1", name: "open" }]),
      );

    const result = await bulkSetState(
      dbMock as never,
      TENANT_ID,
      [
        { id: DUP_ID, state: "bogus" }, // index 0 — invalid
        { id: OTHER_ID, state: "open" }, // index 1 — valid
        { id: DUP_ID, state: "closed" }, // index 2 — invalid (same id as index 0)
      ],
      "actor-1",
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        { index: 0, id: DUP_ID, code: "INVALID_STATE" },
        { index: 2, id: DUP_ID, code: "INVALID_STATE" },
      ]),
    );
    expect(result.errors).toHaveLength(2);
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

  it("applies the createdBy/assignedTo/__accessUsers OR filter when scopeToUserId is provided (R5)", async () => {
    const { eq, or, sql } = await import("drizzle-orm");
    vi.mocked(eq).mockClear();
    vi.mocked(or).mockClear();
    vi.mocked(sql).mockClear();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeInstance]));

    await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
      scopeToUserId: "user-xyz",
    });

    // Three-way OR: createdBy, assignedTo, __accessUsers containment.
    expect(eq).toHaveBeenCalledWith(expect.anything(), "user-xyz");
    expect(or).toHaveBeenCalled();
    expect(sql).toHaveBeenCalled();
  });

  it("omits the scope filter when scopeToUserId is not provided", async () => {
    const { sql } = await import("drizzle-orm");
    vi.mocked(sql).mockClear();
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeInstance]));

    await listEntities(dbMock as never, TENANT_ID, {
      entityTypeId: ENTITY_TYPE_ID,
    });

    // The __accessUsers containment check only fires as part of the
    // scopeToUserId filter (or fieldFilters, unused here) — its absence
    // confirms the scope OR-clause wasn't built.
    expect(sql).not.toHaveBeenCalled();
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
