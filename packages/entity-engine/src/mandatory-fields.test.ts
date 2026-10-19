import { describe, it, expect, vi, afterEach } from "vitest";

const { mockWarn, mockInfo } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));
vi.mock("@platform/logger", () => ({
  logger: { warn: mockWarn, info: mockInfo, error: vi.fn() },
}));

const {
  findMissingMandatoryFields,
  checkMandatoryFields,
  setMandatoryFieldsMode,
  getMandatoryFieldsMode,
} = await import("./mandatory-fields.js");
const { ValidationError } = await import("./errors.js");

// docs/specs/mandatory-ticket-fields.md R4: title, due date, remark, severity, and an
// assignee or a team, on every workflow record.
const COMPLETE = {
  title: "Printer offline",
  dueDate: "2030-01-01T10:00:00.000Z",
  remark: "Reported at the front desk",
  severity: "medium",
  assignedTo: "395069484982861826",
  teamId: undefined,
};
const CONTEXT = { tenantId: "t-1", entityTypeId: "et-1", path: "test" };

describe("findMissingMandatoryFields", () => {
  it("finds nothing missing on a complete record, assigned to a person or a team", () => {
    expect(findMissingMandatoryFields(COMPLETE)).toEqual([]);
    expect(
      findMissingMandatoryFields({
        ...COMPLETE,
        assignedTo: undefined,
        teamId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual([]);
  });

  it("names every missing value, treating whitespace as missing", () => {
    expect(
      findMissingMandatoryFields({
        title: "   ",
        dueDate: null,
        remark: "",
        severity: undefined,
        assignedTo: null,
        teamId: "",
      }).map((e) => e.field),
    ).toEqual(["title", "dueDate", "remark", "severity", "assignedTo"]);
  });

  it("skips only the assignee for the partner exemption", () => {
    expect(
      findMissingMandatoryFields(
        { ...COMPLETE, assignedTo: undefined, remark: "" },
        { assignee: true },
      ).map((e) => e.field),
    ).toEqual(["remark"]);
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

  it("doesn't throw for an exempt assignee under enforce", () => {
    setMandatoryFieldsMode("enforce");
    expect(() =>
      checkMandatoryFields({ ...COMPLETE, assignedTo: undefined }, CONTEXT, {
        assignee: true,
      }),
    ).not.toThrow();
    expect(() =>
      checkMandatoryFields(
        { ...COMPLETE, assignedTo: undefined, remark: "" },
        CONTEXT,
        { assignee: true },
      ),
    ).toThrow(ValidationError);
  });

  it("logs every use of the partner exemption", () => {
    checkMandatoryFields({ ...COMPLETE, assignedTo: undefined }, CONTEXT, {
      assignee: true,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ path: "test" }),
      expect.stringContaining("ADR-012 exemption"),
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
