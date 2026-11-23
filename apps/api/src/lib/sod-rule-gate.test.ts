import { describe, it, expect } from "vitest";
import type { AuthContext } from "@platform/auth";
import {
  assertMayEditRuledWorkflow,
  assertMaySetActorRules,
  isPersonAdmin,
  SodRuleForbiddenError,
  usesActorRule,
  workflowCarriesActorRule,
} from "./sod-rule-gate.js";

const auth = (roles: string[], userId = "u-1"): AuthContext => ({
  tenantId: "t",
  userId,
  roles,
  email: "a@b.c",
});
const RULE = { op: "actor_not_creator" };
const PLAIN = { op: "field_equals", field: "x", value: 1 };

describe("isPersonAdmin", () => {
  it("is true only for a person holding admin", () => {
    expect(isPersonAdmin(auth(["admin"]))).toBe(true);
    expect(isPersonAdmin(auth(["agent"]))).toBe(false);
    expect(isPersonAdmin(auth(["admin"], "apikey:k1"))).toBe(false);
  });
});

describe("usesActorRule", () => {
  it("finds a rule nested under and, and ignores other conditions", () => {
    expect(usesActorRule({ op: "and", children: [PLAIN, RULE] })).toBe(true);
    expect(usesActorRule(PLAIN)).toBe(false);
    expect(usesActorRule(null)).toBe(false);
  });
});

describe("assertMaySetActorRules", () => {
  const agent = auth(["agent"]);

  it("refuses a non-admin adding, changing or removing a rule", () => {
    expect(() => assertMaySetActorRules(agent, null, RULE)).toThrow(
      SodRuleForbiddenError,
    );
    expect(() => assertMaySetActorRules(agent, RULE, PLAIN)).toThrow(
      SodRuleForbiddenError,
    );
    expect(() => assertMaySetActorRules(agent, RULE, null)).toThrow(
      SodRuleForbiddenError,
    );
  });

  it("refuses an API key that carries admin", () => {
    expect(() =>
      assertMaySetActorRules(auth(["admin"], "apikey:k1"), RULE, null),
    ).toThrow(SodRuleForbiddenError);
  });

  it("lets a person admin through", () => {
    expect(() =>
      assertMaySetActorRules(auth(["admin"]), RULE, null),
    ).not.toThrow();
  });

  it("lets a non-admin edit conditions that carry no rule, or leave them alone", () => {
    expect(() => assertMaySetActorRules(agent, null, PLAIN)).not.toThrow();
    expect(() => assertMaySetActorRules(agent, PLAIN, null)).not.toThrow();
    expect(() => assertMaySetActorRules(agent, RULE, undefined)).not.toThrow();
  });

  it("treats re-sending the stored rule, with keys in another order, as no change", () => {
    const stored = { op: "actor_not_prior_actor", states: ["a"] };
    expect(() =>
      assertMaySetActorRules(agent, stored, {
        states: ["a"],
        op: "actor_not_prior_actor",
      }),
    ).not.toThrow();
  });
});

describe("workflowCarriesActorRule (#1132)", () => {
  it("is true when any transition, on any edge, carries an actor rule", () => {
    expect(
      workflowCarriesActorRule([
        { conditions: null },
        { conditions: PLAIN },
        { conditions: { op: "and", children: [PLAIN, RULE] } },
      ]),
    ).toBe(true);
  });

  it("is false for no transitions, no conditions, or only other conditions", () => {
    expect(workflowCarriesActorRule([])).toBe(false);
    expect(
      workflowCarriesActorRule([{ conditions: null }, { conditions: PLAIN }]),
    ).toBe(false);
  });
});

describe("assertMayEditRuledWorkflow (#1132)", () => {
  const agent = auth(["agent"]);
  const personAdmin = auth(["admin"]);
  const apiKeyAdmin = auth(["admin"], "apikey:k1");
  // The rule sits on one edge; the edit is on an unrelated, unruled one.
  const ruledWorkflow = [
    { conditions: RULE },
    { conditions: null },
    { conditions: PLAIN },
  ];

  it("refuses a non-admin on a workflow that carries a rule, whichever transition is edited", () => {
    expect(() =>
      assertMayEditRuledWorkflow(agent, ruledWorkflow, "add a transition"),
    ).toThrow(SodRuleForbiddenError);
  });

  it("names the action in the message", () => {
    expect(() =>
      assertMayEditRuledWorkflow(agent, ruledWorkflow, "change allowed roles"),
    ).toThrow(/change allowed roles/);
  });

  it("refuses an API key carrying admin", () => {
    expect(() =>
      assertMayEditRuledWorkflow(
        apiKeyAdmin,
        ruledWorkflow,
        "add a transition",
      ),
    ).toThrow(SodRuleForbiddenError);
  });

  it("lets a person admin edit a ruled workflow", () => {
    expect(() =>
      assertMayEditRuledWorkflow(
        personAdmin,
        ruledWorkflow,
        "add a transition",
      ),
    ).not.toThrow();
  });

  it("lets a non-admin edit a workflow that carries no actor rule", () => {
    expect(() =>
      assertMayEditRuledWorkflow(
        agent,
        [{ conditions: PLAIN }, { conditions: null }],
        "add a transition",
      ),
    ).not.toThrow();
    expect(() =>
      assertMayEditRuledWorkflow(agent, [], "add a transition"),
    ).not.toThrow();
  });
});
