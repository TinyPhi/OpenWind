import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/db", () => ({ adminAuditLog: {}, tenantUsers: {} }));

const { scrubPersonIdentifiers, PERSON_PLACEHOLDER } =
  await import("./person-identifiers.js");

const known = {
  ids: new Set(["u-alice", "u-bob"]),
  emails: new Set(["alice@example.com"]),
};
const scrub = (v: unknown): { value: unknown; changed: boolean } =>
  scrubPersonIdentifiers(v, known);

describe("scrubPersonIdentifiers (#860)", () => {
  it("replaces a matching string value and reports the change", () => {
    expect(scrub("u-alice")).toEqual({
      value: PERSON_PLACEHOLDER,
      changed: true,
    });
  });

  it("matches an email case-insensitively but an id exactly", () => {
    expect(scrub("Alice@Example.COM").changed).toBe(true);
    expect(scrub("U-ALICE").changed).toBe(false);
  });

  it("reaches nested objects and arrays at any depth", () => {
    const r = scrub({
      targetUserId: "u-alice",
      list: ["x", { deep: ["u-bob"] }],
      n: 3,
      keep: "other",
    });
    expect(r.value).toEqual({
      targetUserId: PERSON_PLACEHOLDER,
      list: ["x", { deep: [PERSON_PLACEHOLDER] }],
      n: 3,
      keep: "other",
    });
    expect(r.changed).toBe(true);
  });

  it("renames object keys that are identifiers, without overwriting each other", () => {
    const r = scrub({ "u-alice": 1, "u-bob": 2, other: 3 });
    expect(r.value).toEqual({
      [PERSON_PLACEHOLDER]: 1,
      [`${PERSON_PLACEHOLDER}#2`]: 2,
      other: 3,
    });
  });

  it("keeps a literal __proto__ key and does not let a real placeholder-named key collide", () => {
    const withProto = JSON.parse(
      '{"__proto__":"keep","ref":"u-alice"}',
    ) as Record<string, unknown>;
    const r = scrub(withProto).value as Record<string, unknown>;
    expect(Object.keys(r)).toEqual(["__proto__", "ref"]);
    expect(r["ref"]).toBe(PERSON_PLACEHOLDER);

    const clash = scrub({ "u-alice": 1, [PERSON_PLACEHOLDER]: 2 }).value;
    expect(Object.keys(clash as object).sort()).toEqual(
      [PERSON_PLACEHOLDER, `${PERSON_PLACEHOLDER}#2`].sort(),
    );
    expect(Object.values(clash as object).sort()).toEqual([1, 2]);
  });

  it("replaces a pathologically deep document whole instead of recursing without bound", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i++) deep = { next: deep };
    const r = scrub(deep);
    expect(r.changed).toBe(true);
  });

  it("leaves a longer string that merely contains an identifier alone", () => {
    expect(scrub("u-alice-extra")).toEqual({
      value: "u-alice-extra",
      changed: false,
    });
  });

  it("returns the same reference and changed:false when nothing matches", () => {
    const input = { a: ["x", { b: "y" }], c: null, d: 1 };
    const r = scrub(input);
    expect(r.changed).toBe(false);
    expect(r.value).toBe(input);
  });

  it("passes null, numbers and booleans through", () => {
    expect(scrub(null)).toEqual({ value: null, changed: false });
    expect(scrub(7)).toEqual({ value: 7, changed: false });
    expect(scrub(true)).toEqual({ value: true, changed: false });
  });
});
