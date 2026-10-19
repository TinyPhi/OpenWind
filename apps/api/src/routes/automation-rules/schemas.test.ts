import { describe, it, expect } from "vitest";
import { ActionConfigSchema } from "./schemas.js";

// docs/specs/mandatory-ticket-fields.md R7: a rule's ticket template survives the API (zod
// drops unknown keys) and anything it sets is valid.
const ENTITY_TYPE = "00000000-0000-4000-8000-000000000042";
const TEAM = "22222222-2222-4222-8222-222222222222";

describe("ActionConfigSchema — ticket template", () => {
  it.each(["create_entity", "create_child"] as const)(
    "keeps a valid template on %s",
    (type) => {
      const template = {
        title: "Costing review",
        due_days: 5,
        remark: "Raised by the tender rule",
        severity: "high",
        assignedTo: "395069484982861826",
      };
      const parsed = ActionConfigSchema.parse({
        type,
        config: { entityTypeId: ENTITY_TYPE, template },
      });
      expect((parsed.config as { template?: unknown }).template).toEqual(
        template,
      );
    },
  );

  it.each([
    ["a negative due_days", { due_days: -1 }],
    ["a fractional due_days", { due_days: 1.5 }],
    ["an unknown severity", { severity: "urgent" }],
    ["a blank remark", { remark: "  " }],
    ["both an assignee and a team", { assignedTo: "u-1", teamId: TEAM }],
    ["a team that isn't a UUID", { teamId: "platform" }],
  ])("rejects %s", (_what, template) => {
    expect(
      ActionConfigSchema.safeParse({
        type: "create_entity",
        config: { entityTypeId: ENTITY_TYPE, template },
      }).success,
    ).toBe(false);
  });

  it("still accepts a rule with no template", () => {
    expect(
      ActionConfigSchema.safeParse({
        type: "create_child",
        config: {},
      }).success,
    ).toBe(true);
  });
});
