import { describe, it, expect } from "vitest";
import type { AuthContext } from "@platform/auth";
import {
  assertMaySetActorRules,
  isPersonAdmin,
  SodRuleForbiddenError,
  usesActorRule,
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
