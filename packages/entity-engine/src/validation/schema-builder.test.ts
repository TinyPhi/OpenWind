import { describe, it, expect } from "vitest";
import { buildZodSchema, transformZodErrors } from "./schema-builder.js";
import type { EntityField } from "../types.js";

function makeField(
  overrides: Partial<EntityField> & {
    name: string;
    fieldType: EntityField["fieldType"];
  },
): EntityField {
  return {
    id: "field-1",
    entityTypeId: "type-1",
    tenantId: null,
    label: overrides.name,
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe("buildZodSchema", () => {
  describe("text field", () => {
    it("accepts a valid string", () => {
      const schema = buildZodSchema(
        [makeField({ name: "title", fieldType: "text" })],
        "create",
      );
      expect(schema.safeParse({ title: "Hello" }).success).toBe(true);
    });

    it("rejects non-string values", () => {
      const schema = buildZodSchema(
        [makeField({ name: "title", fieldType: "text" })],
        "create",
      );
      expect(schema.safeParse({ title: 42 }).success).toBe(false);
    });

    it("enforces maxLength", () => {
      const schema = buildZodSchema(
        [
          makeField({
            name: "title",
            fieldType: "text",
            config: { maxLength: 5 },
          }),
        ],
        "create",
      );
      expect(schema.safeParse({ title: "123456" }).success).toBe(false);
      expect(schema.safeParse({ title: "12345" }).success).toBe(true);
    });

    it("enforces minLength", () => {
      const schema = buildZodSchema(
        [
          makeField({
            name: "title",
            fieldType: "text",
            config: { minLength: 3 },
          }),
        ],
        "create",
      );
      expect(schema.safeParse({ title: "ab" }).success).toBe(false);
      expect(schema.safeParse({ title: "abc" }).success).toBe(true);
    });

    it("enforces pattern", () => {
      const schema = buildZodSchema(
        [
          makeField({
            name: "code",
            fieldType: "text",
            config: { pattern: "^[A-Z]{3}$" },
          }),
        ],
        "create",
      );
      expect(schema.safeParse({ code: "ABC" }).success).toBe(true);
      expect(schema.safeParse({ code: "abc" }).success).toBe(false);
    });
  });

  describe("number field", () => {
    it("accepts a valid number", () => {
      const schema = buildZodSchema(
        [makeField({ name: "qty", fieldType: "number" })],
        "create",
      );
      expect(schema.safeParse({ qty: 5 }).success).toBe(true);
    });

    it("enforces min and max", () => {
      const schema = buildZodSchema(
        [
          makeField({
            name: "qty",
            fieldType: "number",
            config: { min: 1, max: 10 },
          }),
        ],
        "create",
      );
      expect(schema.safeParse({ qty: 0 }).success).toBe(false);
      expect(schema.safeParse({ qty: 11 }).success).toBe(false);
      expect(schema.safeParse({ qty: 5 }).success).toBe(true);
    });

    it("enforces decimalPlaces", () => {
      const schema = buildZodSchema(
        [
          makeField({
            name: "price",
            fieldType: "number",
            config: { decimalPlaces: 2 },
          }),
        ],
        "create",
      );
      expect(schema.safeParse({ price: 9.999 }).success).toBe(false);
      expect(schema.safeParse({ price: 9.99 }).success).toBe(true);
    });
  });

  describe("enum field", () => {
    const field = makeField({
      name: "priority",
      fieldType: "enum",
      config: {
        options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      },
    });

    it("accepts valid enum values", () => {
      const schema = buildZodSchema([field], "create");
      expect(schema.safeParse({ priority: "low" }).success).toBe(true);
    });

    it("rejects invalid enum values", () => {
      const schema = buildZodSchema([field], "create");
      const result = schema.safeParse({ priority: "critical" });
      expect(result.success).toBe(false);
    });
  });

  describe("multi_enum field", () => {
    const field = makeField({
      name: "tags",
      fieldType: "multi_enum",
      config: { options: [{ value: "bug" }, { value: "feature" }] },
    });

    it("accepts an array of valid values", () => {
      const schema = buildZodSchema([field], "create");
      expect(schema.safeParse({ tags: ["bug", "feature"] }).success).toBe(true);
    });

    it("rejects invalid values in array", () => {
      const schema = buildZodSchema([field], "create");
      expect(schema.safeParse({ tags: ["bug", "invalid"] }).success).toBe(
        false,
      );
    });
  });

  describe("boolean field", () => {
    it("accepts true/false", () => {
      const schema = buildZodSchema(
        [makeField({ name: "active", fieldType: "boolean" })],
        "create",
      );
      expect(schema.safeParse({ active: true }).success).toBe(true);
      expect(schema.safeParse({ active: false }).success).toBe(true);
    });

    it("rejects non-boolean", () => {
      const schema = buildZodSchema(
        [makeField({ name: "active", fieldType: "boolean" })],
        "create",
      );
      expect(schema.safeParse({ active: "true" }).success).toBe(false);
    });
  });

  describe("date field", () => {
    it("accepts ISO date string", () => {
      const schema = buildZodSchema(
        [makeField({ name: "dob", fieldType: "date" })],
        "create",
      );
      expect(schema.safeParse({ dob: "2024-01-15" }).success).toBe(true);
    });

    it("rejects invalid date format", () => {
      const schema = buildZodSchema(
        [makeField({ name: "dob", fieldType: "date" })],
        "create",
      );
      expect(schema.safeParse({ dob: "15-01-2024" }).success).toBe(false);
    });
  });

  describe("datetime field", () => {
    it("accepts ISO datetime with offset", () => {
      const schema = buildZodSchema(
        [makeField({ name: "ts", fieldType: "datetime" })],
        "create",
      );
      expect(
        schema.safeParse({ ts: "2024-01-15T10:30:00+05:30" }).success,
      ).toBe(true);
    });
  });

  describe("currency field", () => {
    it("accepts valid currency object", () => {
      const schema = buildZodSchema(
        [makeField({ name: "price", fieldType: "currency" })],
        "create",
      );
      expect(
        schema.safeParse({ price: { amount: 100, currency: "USD" } }).success,
      ).toBe(true);
    });

    it("rejects negative amounts", () => {
      const schema = buildZodSchema(
        [makeField({ name: "price", fieldType: "currency" })],
        "create",
      );
      expect(
        schema.safeParse({ price: { amount: -1, currency: "USD" } }).success,
      ).toBe(false);
    });

    it("enforces allowedCurrencies", () => {
      const schema = buildZodSchema(
        [
          makeField({
            name: "price",
            fieldType: "currency",
            config: { allowedCurrencies: ["INR", "USD"] },
          }),
        ],
        "create",
      );
      expect(
        schema.safeParse({ price: { amount: 100, currency: "EUR" } }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ price: { amount: 100, currency: "INR" } }).success,
      ).toBe(true);
    });
  });

  describe("user_ref / entity_ref fields", () => {
    it("accepts valid UUID", () => {
      const schema = buildZodSchema(
        [makeField({ name: "owner", fieldType: "user_ref" })],
        "create",
      );
      expect(
        schema.safeParse({ owner: "550e8400-e29b-41d4-a716-446655440000" })
          .success,
      ).toBe(true);
    });

    it("rejects non-UUID strings", () => {
      const schema = buildZodSchema(
        [makeField({ name: "owner", fieldType: "user_ref" })],
        "create",
      );
      expect(schema.safeParse({ owner: "not-a-uuid" }).success).toBe(false);
    });
  });

  describe("formula / lookup fields", () => {
    it("are always optional and accept undefined", () => {
      const schema = buildZodSchema(
        [makeField({ name: "total", fieldType: "formula" })],
        "create",
      );
      expect(schema.safeParse({}).success).toBe(true);
    });
  });

  describe("required field enforcement", () => {
    it("requires required fields in create mode", () => {
      const schema = buildZodSchema(
        [makeField({ name: "subject", fieldType: "text", isRequired: true })],
        "create",
      );
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ subject: "Hi" }).success).toBe(true);
    });

    it("makes required fields optional in update mode", () => {
      const schema = buildZodSchema(
        [makeField({ name: "subject", fieldType: "text", isRequired: true })],
        "update",
      );
      expect(schema.safeParse({}).success).toBe(true);
    });
  });
});

describe("transformZodErrors", () => {
  it("maps missing required field to REQUIRED code", () => {
    const schema = buildZodSchema(
      [makeField({ name: "subject", fieldType: "text", isRequired: true })],
      "create",
    );
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = transformZodErrors(result.error);
      expect(errors[0]?.field).toBe("subject");
      expect(errors[0]?.code).toBe("REQUIRED");
    }
  });

  it("maps too_big string to TOO_LONG", () => {
    const schema = buildZodSchema(
      [
        makeField({
          name: "title",
          fieldType: "text",
          config: { maxLength: 3 },
        }),
      ],
      "create",
    );
    const result = schema.safeParse({ title: "abcde" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = transformZodErrors(result.error);
      expect(errors[0]?.code).toBe("TOO_LONG");
      expect(errors[0]?.meta?.max).toBe(3);
    }
  });

  it("maps invalid_enum_value to INVALID_ENUM with options", () => {
    const schema = buildZodSchema(
      [
        makeField({
          name: "priority",
          fieldType: "enum",
          config: { options: [{ value: "low" }, { value: "high" }] },
        }),
      ],
      "create",
    );
    const result = schema.safeParse({ priority: "critical" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = transformZodErrors(result.error);
      expect(errors[0]?.code).toBe("INVALID_ENUM");
      expect(errors[0]?.meta?.options).toEqual(["low", "high"]);
    }
  });
});
