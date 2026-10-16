import { describe, it, expect } from "vitest";
import {
  evaluateConditionTree,
  treeNeedsPriorActors,
  treeUsesActorRule,
} from "./condition-evaluator.js";
import type { ActorContext } from "./types.js";
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

describe("actor rules (segregation of duties)", () => {
  const ctx = (over: Partial<ActorContext> = {}): ActorContext => ({
    actorId: "u-actor",
    createdBy: "u-creator",
    priorActors: [{ actorId: "u-earlier", fromState: "review" }],
    ...over,
  });

  describe("actor_not_creator", () => {
    it("passes for anyone but the creator", () => {
      expect(
        evaluateConditionTree({ op: "actor_not_creator" }, {}, ctx()),
      ).toBe(true);
    });
    it("fails for the creator", () => {
      expect(
        evaluateConditionTree(
          { op: "actor_not_creator" },
          {},
          ctx({ actorId: "u-creator" }),
        ),
      ).toBe(false);
    });
    it("passes when the record has no user creator, for an identified actor", () => {
      expect(
        evaluateConditionTree(
          { op: "actor_not_creator" },
          {},
          ctx({ createdBy: null }),
        ),
      ).toBe(true);
    });
    it("fails closed with no actor, or no context at all", () => {
      expect(
        evaluateConditionTree(
          { op: "actor_not_creator" },
          {},
          ctx({ actorId: null }),
        ),
      ).toBe(false);
      expect(evaluateConditionTree({ op: "actor_not_creator" }, {})).toBe(
        false,
      );
    });
  });

  describe("actor_not_prior_actor", () => {
    it("passes for someone who has not acted, fails for someone who has", () => {
      const tree = { op: "actor_not_prior_actor" } as const;
      expect(evaluateConditionTree(tree, {}, ctx())).toBe(true);
      expect(
        evaluateConditionTree(tree, {}, ctx({ actorId: "u-earlier" })),
      ).toBe(false);
    });
    it("with `states`, only earlier steps that left those states count", () => {
      const left = { op: "actor_not_prior_actor", states: ["review"] } as const;
      const other = { op: "actor_not_prior_actor", states: ["draft"] } as const;
      const asEarlier = ctx({ actorId: "u-earlier" });
      expect(evaluateConditionTree(left, {}, asEarlier)).toBe(false);
      expect(evaluateConditionTree(other, {}, asEarlier)).toBe(true);
    });
    it("fails closed when the prior actors were not loaded, or there is no actor", () => {
      const tree = { op: "actor_not_prior_actor" } as const;
      expect(
        evaluateConditionTree(tree, {}, ctx({ priorActors: undefined })),
      ).toBe(false);
      expect(evaluateConditionTree(tree, {}, ctx({ actorId: null }))).toBe(
        false,
      );
      expect(evaluateConditionTree(tree, {}, undefined)).toBe(false);
    });
  });

  it("composes with field conditions and and/or/not", () => {
    const tree = {
      op: "and",
      children: [
        { op: "gte", field: "amount", value: 1000 },
        {
          op: "or",
          children: [
            { op: "actor_not_creator" },
            { op: "eq", field: "waived", value: true },
          ],
        },
      ],
    } as const;
    const creator = ctx({ actorId: "u-creator" });
    expect(evaluateConditionTree(tree, { amount: 5000 }, creator)).toBe(false);
    expect(
      evaluateConditionTree(tree, { amount: 5000, waived: true }, creator),
    ).toBe(true);
    expect(evaluateConditionTree(tree, { amount: 5000 }, ctx())).toBe(true);
    expect(evaluateConditionTree(tree, { amount: 10 }, ctx())).toBe(false);
  });

  describe("actor_is_creator", () => {
    it("passes only for the creator", () => {
      expect(
        evaluateConditionTree(
          { op: "actor_is_creator" },
          {},
          ctx({ actorId: "u-creator" }),
        ),
      ).toBe(true);
      expect(evaluateConditionTree({ op: "actor_is_creator" }, {}, ctx())).toBe(
        false,
      );
    });
    it("fails closed with no actor, no creator, or no context", () => {
      expect(
        evaluateConditionTree(
          { op: "actor_is_creator" },
          {},
          ctx({ actorId: null }),
        ),
      ).toBe(false);
      expect(
        evaluateConditionTree(
          { op: "actor_is_creator" },
          {},
          ctx({ createdBy: null }),
        ),
      ).toBe(false);
      expect(evaluateConditionTree({ op: "actor_is_creator" }, {})).toBe(false);
    });
  });

  describe("an actor rule under not() is never satisfied", () => {
    // not(actor_not_creator) would read as "only the creator" but would PASS an unidentified
    // actor, because the inner rule fails closed and not() inverts the refusal.
    it.each([
      ["actor_not_creator", { op: "actor_not_creator" }],
      ["actor_is_creator", { op: "actor_is_creator" }],
      ["actor_not_prior_actor", { op: "actor_not_prior_actor" }],
    ] as const)("%s", (_name, child) => {
      const tree = { op: "not", child } as const;
      expect(evaluateConditionTree(tree, {}, ctx())).toBe(false);
      expect(
        evaluateConditionTree(tree, {}, ctx({ actorId: "u-creator" })),
      ).toBe(false);
      expect(evaluateConditionTree(tree, {}, ctx({ actorId: null }))).toBe(
        false,
      );
      expect(evaluateConditionTree(tree, {})).toBe(false);
    });
    it("including when buried inside and/or", () => {
      const tree = {
        op: "or",
        children: [
          {
            op: "and",
            children: [{ op: "not", child: { op: "actor_not_creator" } }],
          },
        ],
      } as const;
      expect(evaluateConditionTree(tree, {}, ctx({ actorId: null }))).toBe(
        false,
      );
    });
    it("but not() over a plain field condition is unaffected", () => {
      expect(
        evaluateConditionTree(
          { op: "not", child: { op: "eq", field: "a", value: 1 } },
          { a: 2 },
        ),
      ).toBe(true);
    });
  });

  describe("treeUsesActorRule", () => {
    it("is true for any actor rule at any depth, false for field-only trees", () => {
      expect(treeUsesActorRule(null)).toBe(false);
      expect(treeUsesActorRule({ op: "eq", field: "a", value: 1 })).toBe(false);
      expect(treeUsesActorRule({ op: "actor_not_creator" })).toBe(true);
      expect(treeUsesActorRule({ op: "actor_is_creator" })).toBe(true);
      expect(
        treeUsesActorRule({
          op: "and",
          children: [{ op: "not", child: { op: "actor_not_prior_actor" } }],
        }),
      ).toBe(true);
    });
  });

  describe("treeNeedsPriorActors", () => {
    it("is true only when an actor_not_prior_actor rule is present, at any depth", () => {
      expect(treeNeedsPriorActors(null)).toBe(false);
      expect(treeNeedsPriorActors({ op: "actor_not_creator" })).toBe(false);
      expect(treeNeedsPriorActors({ op: "eq", field: "a", value: 1 })).toBe(
        false,
      );
      expect(treeNeedsPriorActors({ op: "actor_not_prior_actor" })).toBe(true);
      expect(
        treeNeedsPriorActors({
          op: "and",
          children: [{ op: "not", child: { op: "actor_not_prior_actor" } }],
        }),
      ).toBe(true);
    });
  });
});
