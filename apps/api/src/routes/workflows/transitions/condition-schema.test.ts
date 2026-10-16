import { describe, it, expect } from "vitest";
import { TransitionConditionsSchema } from "./condition-schema.js";

const ok = (v: unknown): boolean =>
  TransitionConditionsSchema.safeParse(v).success;

describe("TransitionConditionsSchema", () => {
  it("accepts field conditions, the actor rules, and nesting of them", () => {
    expect(ok({ op: "eq", field: "status", value: "open" })).toBe(true);
    expect(ok({ op: "actor_not_creator" })).toBe(true);
    expect(ok({ op: "actor_is_creator" })).toBe(true);
    expect(ok({ op: "actor_not_prior_actor" })).toBe(true);
    expect(
      ok({ op: "actor_not_prior_actor", states: ["review", "legal"] }),
    ).toBe(true);
    expect(
      ok({
        op: "and",
        children: [
          { op: "gte", field: "amount", value: 5000 },
          { op: "not", child: { op: "eq", field: "waived", value: true } },
          { op: "actor_is_creator" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an actor rule under `not`, however deep, with a message pointing at actor_is_creator", () => {
    for (const child of [
      { op: "actor_not_creator" },
      { op: "actor_is_creator" },
      { op: "actor_not_prior_actor" },
      { op: "and", children: [{ op: "actor_not_creator" }] },
    ]) {
      const r = TransitionConditionsSchema.safeParse({ op: "not", child });
      expect(r.success).toBe(false);
    }
    const r = TransitionConditionsSchema.safeParse({
      op: "not",
      child: { op: "actor_not_creator" },
    });
    expect(JSON.stringify(r)).toContain("actor_is_creator");
  });

  it("accepts a tree exactly at the depth limit and rejects one level deeper", () => {
    const nest = (levels: number): unknown => {
      let t: unknown = { op: "eq", field: "a", value: 1 };
      for (let i = 0; i < levels; i++) t = { op: "not", child: t };
      return t;
    };
    expect(ok(nest(7))).toBe(true); // 7 wrappers + 1 leaf = depth 8
    expect(ok(nest(8))).toBe(false);
  });

  it("parses a pathologically deep payload without recursing (bounded by construction)", () => {
    let deep: unknown = { op: "eq", field: "a", value: 1 };
    for (let i = 0; i < 5000; i++) deep = { op: "not", child: deep };
    expect(() => TransitionConditionsSchema.safeParse(deep)).not.toThrow();
    expect(ok(deep)).toBe(false);
  });

  it("rejects an unknown operator, so a typo cannot silently lock a transition", () => {
    expect(ok({ op: "actor_not_creater" })).toBe(false);
    expect(ok({ op: "equals", field: "a", value: 1 })).toBe(false);
  });

  it("rejects stray keys on an actor rule and an empty states list", () => {
    expect(ok({ op: "actor_not_creator", field: "x" })).toBe(false);
    expect(ok({ op: "actor_not_prior_actor", states: [] })).toBe(false);
    expect(ok({ op: "actor_not_prior_actor", states: [""] })).toBe(false);
  });

  it("rejects empty and/or groups and a field condition with no field", () => {
    expect(ok({ op: "and", children: [] })).toBe(false);
    expect(ok({ op: "or", children: [] })).toBe(false);
    expect(ok({ op: "eq", value: 1 })).toBe(false);
  });

  it("rejects a tree nested deeper than the limit and an oversized group", () => {
    let deep: unknown = { op: "eq", field: "a", value: 1 };
    for (let i = 0; i < 9; i++) deep = { op: "not", child: deep };
    expect(ok(deep)).toBe(false);
    const wide = {
      op: "and",
      children: Array.from({ length: 21 }, () => ({ op: "actor_not_creator" })),
    };
    expect(ok(wide)).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(ok("actor_not_creator")).toBe(false);
    expect(ok(42)).toBe(false);
    expect(ok([])).toBe(false);
  });
});
