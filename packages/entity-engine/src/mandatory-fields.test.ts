import { describe, it, expect, vi, afterEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@platform/logger", () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

const {
  findMissingMandatoryFields,
  checkMandatoryFields,
  checkMandatoryFieldsOnUpdate,
  setMandatoryFieldsMode,
  getMandatoryFieldsMode,
} = await import("./mandatory-fields.js");
const { ValidationError } = await import("./errors.js");

// docs/specs/mandatory-ticket-fields.md R4: title, due date, remark and severity on every
// workflow record. The assignee is optional (owner decision 2026-10-19).
const COMPLETE = {
  title: "Printer offline",
  dueDate: "2030-01-01T10:00:00.000Z",
  remark: "Reported at the front desk",
  severity: "medium",
};
const CONTEXT = { tenantId: "t-1", entityTypeId: "et-1", path: "test" };

describe("findMissingMandatoryFields", () => {
  it("finds nothing missing on a complete record", () => {
    expect(findMissingMandatoryFields(COMPLETE)).toEqual([]);
  });

  it("names every missing value, treating whitespace as missing", () => {
    expect(
      findMissingMandatoryFields({
        title: "   ",
        dueDate: null,
        remark: "",
        severity: undefined,
      }).map((e) => e.field),
    ).toEqual(["title", "dueDate", "remark", "severity"]);
  });
});

describe("checkMandatoryFields", () => {
  afterEach(() => {
    setMandatoryFieldsMode("log");
    vi.clearAllMocks();
  });

  it("defaults to log: warns with the missing fields and doesn't throw", () => {
    expect(getMandatoryFieldsMode()).toBe("log");
    expect(() =>
      checkMandatoryFields({ ...COMPLETE, remark: null }, CONTEXT),
    ).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ["remark"], path: "test" }),
      expect.stringContaining("mandatory-fields"),
    );
  });

  it("throws a ValidationError naming the missing fields under enforce", () => {
    setMandatoryFieldsMode("enforce");
    let thrown: unknown;
    try {
      checkMandatoryFields({ ...COMPLETE, dueDate: undefined }, CONTEXT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as InstanceType<typeof ValidationError>).fields).toEqual([
      { field: "dueDate", code: "required", message: "Due date is required" },
    ]);
  });

  it("stays silent for a complete record", () => {
    setMandatoryFieldsMode("enforce");
    expect(() => checkMandatoryFields(COMPLETE, CONTEXT)).not.toThrow();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

// docs/specs/mandatory-ticket-fields.md R5: no edit removes a value the record had.
describe("checkMandatoryFieldsOnUpdate", () => {
  afterEach(() => {
    setMandatoryFieldsMode("log");
    vi.clearAllMocks();
  });

  it("throws under enforce when an edit removes a value", () => {
    setMandatoryFieldsMode("enforce");
    expect(() =>
      checkMandatoryFieldsOnUpdate(
        COMPLETE,
        { ...COMPLETE, dueDate: null },
        CONTEXT,
      ),
    ).toThrow(ValidationError);
  });

  it("lets an older record missing a value be edited", () => {
    setMandatoryFieldsMode("enforce");
    const legacy = { ...COMPLETE, remark: null };
    expect(() =>
      checkMandatoryFieldsOnUpdate(
        legacy,
        { ...legacy, title: "Renamed" },
        CONTEXT,
      ),
    ).not.toThrow();
  });

  it("logs, without throwing, in log mode", () => {
    expect(() =>
      checkMandatoryFieldsOnUpdate(
        COMPLETE,
        { ...COMPLETE, title: " " },
        CONTEXT,
      ),
    ).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ["title"] }),
      expect.stringContaining("edited to remove"),
    );
  });
});
