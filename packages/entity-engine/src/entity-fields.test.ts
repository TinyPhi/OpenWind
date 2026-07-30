import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @platform/db ─────────────────────────────────────────────────────────

const mockInsertReturning = vi.fn();
const mockUpdateReturning = vi.fn();
const mockSelectResult = vi.fn();

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
      where: vi.fn(() => ({ returning: mockUpdateReturning })),
    })),
  })),
  delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
};

vi.mock("@platform/db", () => ({
  entityFields: {
    id: "id",
    tenantId: "tenant_id",
    entityTypeId: "entity_type_id",
    name: "name",
    createdAt: "created_at",
    isSystem: "is_system",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  or: vi.fn((...args) => ({ args, op: "or" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  asc: vi.fn((col) => ({ col, op: "asc" })),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./validation/index.js", () => ({
  invalidateSchemaCache: vi.fn().mockResolvedValue(undefined),
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────

const { listEntityFields, updateEntityField, deleteEntityField } =
  await import("./entity-fields.js");
const { invalidateSchemaCache } = await import("./validation/index.js");

const TENANT_ID = "tenant-aaa";
const TYPE_ID = "type-bbb";
const FIELD_ID = "field-ccc";

const fakeField = {
  id: FIELD_ID,
  entityTypeId: TYPE_ID,
  tenantId: TENANT_ID,
  name: "subject",
  label: "Subject",
  fieldType: "text",
  config: {},
  isRequired: false,
  isIndexed: false,
  isSystem: false,
  sortOrder: 0,
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

const fakeSystemField = {
  ...fakeField,
  id: "field-system",
  name: "id",
  label: "ID",
  isSystem: true,
};

describe("listEntityFields", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all fields for the entity type", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeField]));
    const fields = await listEntityFields(dbMock as never, TENANT_ID, TYPE_ID);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe("subject");
  });

  it("returns empty array when no fields found", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    const fields = await listEntityFields(dbMock as never, TENANT_ID, TYPE_ID);
    expect(fields).toHaveLength(0);
  });

  it("returns multiple fields in sortOrder order", async () => {
    const rows = [
      { ...fakeField, id: "field-1", sortOrder: 2 },
      { ...fakeField, id: "field-2", sortOrder: 0 },
      { ...fakeField, id: "field-3", sortOrder: 1 },
    ];
    dbMock.select.mockReturnValue(makeQueryBuilder(() => rows));
    const fields = await listEntityFields(dbMock as never, TENANT_ID, TYPE_ID);
    // ordering is done by DB; mock returns as-is, but we verify all 3 come back
    expect(fields).toHaveLength(3);
  });
});

describe("updateEntityField", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates and returns the field", async () => {
    const updated = { ...fakeField, label: "Title" };
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeField]));
    mockUpdateReturning.mockResolvedValue([updated]);
    const result = await updateEntityField(
      dbMock as never,
      TENANT_ID,
      TYPE_ID,
      FIELD_ID,
      { label: "Title" },
    );
    expect(result.label).toBe("Title");
    expect(invalidateSchemaCache).toHaveBeenCalledWith(TYPE_ID, TENANT_ID);
  });

  it("returns existing field unchanged when input is empty", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeField]));
    const result = await updateEntityField(
      dbMock as never,
      TENANT_ID,
      TYPE_ID,
      FIELD_ID,
      {},
    );
    expect(result.id).toBe(FIELD_ID);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(invalidateSchemaCache).not.toHaveBeenCalled();
  });

  it("throws FIELD_NOT_FOUND when field does not exist", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      updateEntityField(dbMock as never, TENANT_ID, TYPE_ID, "nonexistent", {
        label: "x",
      }),
    ).rejects.toMatchObject({ code: "FIELD_NOT_FOUND" });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("throws SYSTEM_FIELD_IMMUTABLE when attempting to update a system field", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeSystemField]));
    await expect(
      updateEntityField(
        dbMock as never,
        TENANT_ID,
        TYPE_ID,
        fakeSystemField.id,
        { label: "New Label" },
      ),
    ).rejects.toMatchObject({ code: "SYSTEM_FIELD_IMMUTABLE" });
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe("deleteEntityField", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a custom field and invalidates the schema cache", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeField]));
    await expect(
      deleteEntityField(dbMock as never, TENANT_ID, TYPE_ID, FIELD_ID),
    ).resolves.toBeUndefined();
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    expect(invalidateSchemaCache).toHaveBeenCalledWith(TYPE_ID, TENANT_ID);
  });

  it("throws SYSTEM_FIELD_IMMUTABLE when attempting to delete a system field", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => [fakeSystemField]));
    await expect(
      deleteEntityField(
        dbMock as never,
        TENANT_ID,
        TYPE_ID,
        fakeSystemField.id,
      ),
    ).rejects.toMatchObject({ code: "SYSTEM_FIELD_IMMUTABLE" });
    expect(dbMock.delete).not.toHaveBeenCalled();
    expect(invalidateSchemaCache).not.toHaveBeenCalled();
  });

  it("throws FIELD_NOT_FOUND when field does not exist", async () => {
    dbMock.select.mockReturnValue(makeQueryBuilder(() => []));
    await expect(
      deleteEntityField(dbMock as never, TENANT_ID, TYPE_ID, "nonexistent"),
    ).rejects.toMatchObject({ code: "FIELD_NOT_FOUND" });
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});
