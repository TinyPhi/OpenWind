import { describe, it, expect } from "vitest";
import {
  buildTemplateVariables,
  renderTemplate,
  TemplateSchema,
} from "./template.js";

describe("buildTemplateVariables", () => {
  it("resolves month/year/date from the fire instant in the rule's timezone", () => {
    const vars = buildTemplateVariables(
      new Date("2026-10-25T04:00:00Z"),
      "Asia/Kolkata",
      "Monthly Review",
    );
    expect(vars.month).toBe("October");
    expect(vars.month_short).toBe("Oct");
    expect(vars.year).toBe("2026");
    expect(vars.rule_name).toBe("Monthly Review");
  });

  it("uses the LOCAL calendar date, not the UTC date, near a timezone boundary", () => {
    // 2026-10-01T03:30Z in America/New_York (UTC-4 in October, DST) is
    // 2026-09-30T23:30 local -- the previous day.
    const vars = buildTemplateVariables(
      new Date("2026-10-01T03:30:00Z"),
      "America/New_York",
      "Sync",
    );
    expect(vars.date).toBe("2026-09-30");
  });

  it("computes the ISO week number", () => {
    const vars = buildTemplateVariables(
      new Date("2026-10-19T04:00:00Z"),
      "Asia/Kolkata",
      "Weekly report",
    );
    expect(vars.week).toBe("43");
  });
});

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

describe("renderTemplate", () => {
  const baseTemplate = TemplateSchema.parse({
    title: "Monthly Review — {{month}} {{year}}",
    description: "Prepare for the {{month}} review, ref {{rule_name}}.",
    teamId: TEAM_ID,
    due_days: 2,
    remark: "Auto-created by the monthly review rule.",
    fields: { due_date: "{{date}}", other: 42 },
  });

  it("substitutes known tokens in title, description, and string fields", () => {
    const vars = {
      date: "2026-10-25",
      month: "October",
      month_short: "Oct",
      year: "2026",
      week: "43",
      rule_name: "Monthly Review",
    };
    const rendered = renderTemplate(baseTemplate, vars);
    expect(rendered.title).toBe("Monthly Review — October 2026");
    expect(rendered.description).toBe(
      "Prepare for the October review, ref Monthly Review.",
    );
    expect(rendered.fields?.due_date).toBe("2026-10-25");
    expect(rendered.fields?.other).toBe(42); // non-string values untouched
  });

  it("leaves unknown tokens as literal text (closed whitelist)", () => {
    const template = TemplateSchema.parse({
      title: "Report {{unknown}} token",
      teamId: TEAM_ID,
      due_days: 0,
      remark: "x",
    });
    const rendered = renderTemplate(template, {
      date: "2026-10-25",
      month: "October",
      month_short: "Oct",
      year: "2026",
      week: "43",
      rule_name: "x",
    });
    expect(rendered.title).toBe("Report {{unknown}} token");
  });
});

describe("TemplateSchema", () => {
  const valid = { title: "x", due_days: 1, remark: "r" };

  it("rejects a whitespace-only title", () => {
    expect(() =>
      TemplateSchema.parse({ ...valid, title: "   ", teamId: TEAM_ID }),
    ).toThrow();
  });

  it("rejects an invalid severity value", () => {
    expect(() =>
      TemplateSchema.parse({
        ...valid,
        severity: "urgent",
        teamId: TEAM_ID,
      }),
    ).toThrow();
  });

  it("accepts a valid teamId-only template", () => {
    expect(() =>
      TemplateSchema.parse({ ...valid, teamId: TEAM_ID }),
    ).not.toThrow();
  });

  it("accepts a valid assignedTo-only template", () => {
    expect(() =>
      TemplateSchema.parse({ ...valid, assignedTo: USER_ID }),
    ).not.toThrow();
  });

  it("rejects a template with neither assignedTo nor teamId", () => {
    expect(() => TemplateSchema.parse(valid)).toThrow();
  });

  it("rejects a template with both assignedTo and teamId", () => {
    expect(() =>
      TemplateSchema.parse({ ...valid, assignedTo: USER_ID, teamId: TEAM_ID }),
    ).toThrow();
  });

  it("rejects a missing remark", () => {
    expect(() =>
      TemplateSchema.parse({
        title: "x",
        due_days: 1,
        teamId: TEAM_ID,
      }),
    ).toThrow();
  });

  it("rejects a negative due_days", () => {
    expect(() =>
      TemplateSchema.parse({ ...valid, due_days: -1, teamId: TEAM_ID }),
    ).toThrow();
  });
});
