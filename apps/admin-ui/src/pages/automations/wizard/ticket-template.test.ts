import { describe, it, expect } from "vitest";
import {
  completeTemplate,
  defaultTemplate,
  needsTemplate,
  ticketActionProblem,
} from "./ticket-template.js";

// docs/specs/mandatory-ticket-fields.md R7.
describe("ticketActionProblem", () => {
  const complete = {
    entityTypeId: "et-1",
    template: { due_days: 3, severity: "medium" },
  };

  it("accepts a create action with a workflow, due days and severity", () => {
    expect(ticketActionProblem("create_entity", complete)).toBeNull();
    expect(
      ticketActionProblem("create_child", { template: defaultTemplate() }),
    ).toBeNull();
  });

  it.each([
    ["no workflow", { ...complete, entityTypeId: "" }, /workflow/],
    [
      "a fractional due",
      { ...complete, template: { due_days: 1.5, severity: "low" } },
      /whole number/,
    ],
    [
      "a negative due",
      { ...complete, template: { due_days: -1, severity: "low" } },
      /whole number/,
    ],
    ["no severity", { ...complete, template: { due_days: 3 } }, /severity/],
    [
      "both a person and a team",
      {
        ...complete,
        template: {
          due_days: 3,
          severity: "low",
          assignedTo: "395069484982861826",
          teamId: "team-1",
        },
      },
      /not both/,
    ],
  ])("blocks a create-ticket action with %s", (_what, config, message) => {
    expect(ticketActionProblem("create_entity", config)).toMatch(message);
  });
});

describe("completeTemplate", () => {
  it("fills a blank title and remark from the rule's name, and keeps other config", () => {
    expect(
      completeTemplate(
        "create_entity",
        {
          entityTypeId: "et-1",
          fields: { priority: "high" },
          template: {
            due_days: 2,
            severity: "high",
            title: " ",
            assignedTo: "",
          },
        },
        "Costing review",
      ),
    ).toEqual({
      entityTypeId: "et-1",
      fields: { priority: "high" },
      template: {
        due_days: 2,
        severity: "high",
        title: "Costing review",
        remark: "Created by automation: Costing review",
      },
    });
  });

  it("leaves a sub-task's blank title to the engine's '<rule>: <parent>' default", () => {
    const done = completeTemplate(
      "create_child",
      { template: defaultTemplate() },
      "Follow-up",
    );
    expect(done.template).toEqual({
      due_days: 3,
      severity: "medium",
      remark: "Created by automation: Follow-up",
    });
  });

  it("keeps the values the rule sets", () => {
    const template = {
      title: "Price the roof",
      due_days: 7,
      remark: "From the tender",
      severity: "high",
      teamId: "team-1",
    };
    expect(
      completeTemplate("create_entity", { template }, "Rule").template,
    ).toEqual(template);
  });
});

describe("needsTemplate", () => {
  const full = {
    title: "T",
    due_days: 1,
    remark: "R",
    severity: "low",
  };

  it("flags a create action missing a mandatory template value", () => {
    expect(needsTemplate([{ type: "create_entity", config: {} }])).toBe(true);
    expect(
      needsTemplate([
        {
          type: "create_entity",
          config: { template: { ...full, title: undefined } },
        },
      ]),
    ).toBe(true);
    expect(
      needsTemplate([
        { type: "create_child", config: { template: { due_days: 1 } } },
      ]),
    ).toBe(true);
  });

  it("flags a create action with a full template but no workflow", () => {
    expect(
      needsTemplate([{ type: "create_entity", config: { template: full } }]),
    ).toBe(true);
    expect(
      needsTemplate([
        {
          type: "create_entity",
          config: { entityTypeId: "  ", template: full },
        },
      ]),
    ).toBe(true);
  });

  it("treats a template stored as an array as missing", () => {
    expect(
      needsTemplate([
        {
          type: "create_entity",
          config: { entityTypeId: "et-1", template: [] },
        },
      ]),
    ).toBe(true);
  });

  it("doesn't flag a complete template, a sub-task without a title, or other actions", () => {
    expect(
      needsTemplate([
        {
          type: "create_entity",
          config: { entityTypeId: "et-1", template: full },
        },
      ]),
    ).toBe(false);
    expect(
      needsTemplate([
        {
          type: "create_child",
          config: { template: { ...full, title: undefined } },
        },
      ]),
    ).toBe(false);
    expect(needsTemplate([{ type: "notify", config: {} }])).toBe(false);
  });
});
