import { describe, it, expect, vi } from "vitest";
import {
  resolveLookupFields,
  resolveLookupFieldsBatch,
} from "./lookup-resolver.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const TENANT = "tenant-aaa";
const FROM_ID = "instance-111";
const TO_ID = "instance-222";

function makeDb(relations: unknown[], targets: unknown[]) {
  let callCount = 0;
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockImplementation(() => {
          // first select call = relations query, second = target instances
          return callCount++ === 0 ? relations : targets;
        }),
      })),
    })),
  };
}

function makeBatchDb(relations: unknown[], targets: unknown[]) {
  let callCount = 0;
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        // batch queries don't use .limit()
        const result = callCount++ === 0 ? relations : targets;
        return result;
      }),
    })),
  };
}

const lookupField = {
  name: "parent_subject",
  fieldType: "lookup" as const,
  config: { relationType: "parent_ticket", targetField: "subject" },
};

const textField = {
  name: "title",
  fieldType: "text" as const,
  config: {},
};

// ── resolveLookupFields ───────────────────────────────────────────────────────

describe("resolveLookupFields", () => {
  it("returns values unchanged when no lookup fields are present", async () => {
    const db = makeDb([], []);
    const values = { title: "hello" };
    const result = await resolveLookupFields(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      FROM_ID,
      [textField],
      values,
    );
    expect(result).toEqual({ title: "hello" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("resolves lookup field from related instance", async () => {
    const db = makeDb(
      [{ toInstanceId: TO_ID }],
      [{ fields: { subject: "Bug: login fails" } }],
    );
    const values = { title: "hello" };
    const result = await resolveLookupFields(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      FROM_ID,
      [lookupField, textField],
      values,
    );
    expect(result["parent_subject"]).toBe("Bug: login fails");
    expect(result["title"]).toBe("hello");
  });

  it("sets lookup field to null when no relation exists", async () => {
    const db = makeDb([], []);
    const values = { title: "hello" };
    const result = await resolveLookupFields(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      FROM_ID,
      [lookupField],
      values,
    );
    expect(result["parent_subject"]).toBeUndefined();
  });

  it("sets lookup field to null when target field is absent", async () => {
    const db = makeDb(
      [{ toInstanceId: TO_ID }],
      [{ fields: { other_field: "value" } }],
    );
    const result = await resolveLookupFields(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      FROM_ID,
      [lookupField],
      {},
    );
    expect(result["parent_subject"]).toBeNull();
  });

  it("skips lookup fields with invalid config", async () => {
    const badField = {
      name: "bad_lookup",
      fieldType: "lookup" as const,
      config: { relationType: 123 }, // invalid — not a string
    };
    const db = makeDb([], []);
    const result = await resolveLookupFields(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      FROM_ID,
      [badField],
      {},
    );
    expect(result["bad_lookup"]).toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does not follow relation chains beyond depth 1", async () => {
    // The target instance has its own lookup field — but we only read its plain
    // fields, never recurse into further relations.
    const db = makeDb(
      [{ toInstanceId: TO_ID }],
      [{ fields: { subject: "top-level value" } }],
    );
    const result = await resolveLookupFields(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      FROM_ID,
      [lookupField],
      {},
    );
    // select was called exactly twice: once for the relation, once for the target
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(result["parent_subject"]).toBe("top-level value");
  });
});

// ── resolveLookupFieldsBatch ──────────────────────────────────────────────────

describe("resolveLookupFieldsBatch", () => {
  it("returns map unchanged when no lookup fields are present", async () => {
    const db = makeBatchDb([], []);
    const instances = [{ id: FROM_ID, fields: { title: "a" } }];
    const result = await resolveLookupFieldsBatch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      instances,
      [textField],
    );
    expect(result.get(FROM_ID)).toEqual({ title: "a" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns empty map when instances list is empty", async () => {
    const db = makeBatchDb([], []);
    const result = await resolveLookupFieldsBatch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      [],
      [lookupField],
    );
    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("resolves lookup for multiple instances with two queries per relationType", async () => {
    const ID_A = "inst-a";
    const ID_B = "inst-b";
    const TO_A = "target-a";
    const TO_B = "target-b";

    const db = makeBatchDb(
      [
        { fromInstanceId: ID_A, toInstanceId: TO_A },
        { fromInstanceId: ID_B, toInstanceId: TO_B },
      ],
      [
        { id: TO_A, fields: { subject: "Subject A" } },
        { id: TO_B, fields: { subject: "Subject B" } },
      ],
    );

    const instances = [
      { id: ID_A, fields: { title: "a" } },
      { id: ID_B, fields: { title: "b" } },
    ];

    const result = await resolveLookupFieldsBatch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      instances,
      [lookupField],
    );

    expect(result.get(ID_A)?.["parent_subject"]).toBe("Subject A");
    expect(result.get(ID_B)?.["parent_subject"]).toBe("Subject B");
    // exactly 2 selects for one relationType: relations + targets
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("only follows the first relation per (fromInstanceId, relationType)", async () => {
    // Simulate duplicate relations — only the first toInstanceId should be used
    const db = makeBatchDb(
      [
        { fromInstanceId: FROM_ID, toInstanceId: TO_ID },
        { fromInstanceId: FROM_ID, toInstanceId: "other-target" },
      ],
      [{ id: TO_ID, fields: { subject: "first target" } }],
    );

    const instances = [{ id: FROM_ID, fields: {} }];
    const result = await resolveLookupFieldsBatch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      TENANT,
      instances,
      [lookupField],
    );
    expect(result.get(FROM_ID)?.["parent_subject"]).toBe("first target");
  });
});
