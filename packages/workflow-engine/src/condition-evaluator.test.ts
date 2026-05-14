import { describe, it, expect } from "vitest";
import { evaluateConditionTree } from "./condition-evaluator.js";
import type { ConditionTree } from "./types.js";

const fields = {
  amount: 500,
  status: "open",
  name: "Alice",
  tags: ["urgent"],
  empty_field: "",
};

describe("evaluateConditionTree", () => {
  it("returns true for null condition (no condition)", () => {
    expect(evaluateConditionTree(null, fields)).toBe(true);
  });

  describe("field conditions", () => {
    it("eq: matches equal value", () => {
      const cond: ConditionTree = { op: "eq", field: "status", value: "open" };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("eq: fails on unequal value", () => {
      const cond: ConditionTree = {
        op: "eq",
        field: "status",
        value: "closed",
      };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("neq: passes when not equal", () => {
      const cond: ConditionTree = {
        op: "neq",
        field: "status",
        value: "closed",
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("gt: passes when value is greater", () => {
      const cond: ConditionTree = { op: "gt", field: "amount", value: 100 };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("gt: fails when value is equal", () => {
      const cond: ConditionTree = { op: "gt", field: "amount", value: 500 };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("gte: passes when equal", () => {
      const cond: ConditionTree = { op: "gte", field: "amount", value: 500 };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("lt: passes when value is less", () => {
      const cond: ConditionTree = { op: "lt", field: "amount", value: 1000 };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("lte: passes when equal", () => {
      const cond: ConditionTree = { op: "lte", field: "amount", value: 500 };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("contains: passes when string contains substring", () => {
      const cond: ConditionTree = {
        op: "contains",
        field: "name",
        value: "lic",
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("contains: fails when string does not contain substring", () => {
      const cond: ConditionTree = {
        op: "contains",
        field: "name",
        value: "Bob",
      };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("in: passes when value is in array", () => {
      const cond: ConditionTree = {
        op: "in",
        field: "status",
        value: ["open", "pending"],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("in: fails when value is not in array", () => {
      const cond: ConditionTree = {
        op: "in",
        field: "status",
        value: ["closed"],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("empty: passes for empty string", () => {
      const cond: ConditionTree = { op: "empty", field: "empty_field" };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("empty: fails for non-empty value", () => {
      const cond: ConditionTree = { op: "empty", field: "name" };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("not_empty: passes for non-empty value", () => {
      const cond: ConditionTree = { op: "not_empty", field: "name" };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });
  });

  describe("logical operators", () => {
    it("and: passes when all children pass", () => {
      const cond: ConditionTree = {
        op: "and",
        children: [
          { op: "eq", field: "status", value: "open" },
          { op: "gt", field: "amount", value: 100 },
        ],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("and: fails when any child fails", () => {
      const cond: ConditionTree = {
        op: "and",
        children: [
          { op: "eq", field: "status", value: "open" },
          { op: "gt", field: "amount", value: 10000 },
        ],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("or: passes when any child passes", () => {
      const cond: ConditionTree = {
        op: "or",
        children: [
          { op: "eq", field: "status", value: "closed" },
          { op: "gt", field: "amount", value: 100 },
        ],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("or: fails when all children fail", () => {
      const cond: ConditionTree = {
        op: "or",
        children: [
          { op: "eq", field: "status", value: "closed" },
          { op: "gt", field: "amount", value: 10000 },
        ],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("not: inverts a passing condition", () => {
      const cond: ConditionTree = {
        op: "not",
        child: { op: "eq", field: "status", value: "open" },
      };
      expect(evaluateConditionTree(cond, fields)).toBe(false);
    });

    it("not: inverts a failing condition", () => {
      const cond: ConditionTree = {
        op: "not",
        child: { op: "eq", field: "status", value: "closed" },
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });

    it("handles nested and/or", () => {
      const cond: ConditionTree = {
        op: "and",
        children: [
          { op: "not_empty", field: "name" },
          {
            op: "or",
            children: [
              { op: "eq", field: "status", value: "closed" },
              { op: "gte", field: "amount", value: 500 },
            ],
          },
        ],
      };
      expect(evaluateConditionTree(cond, fields)).toBe(true);
    });
  });
});
