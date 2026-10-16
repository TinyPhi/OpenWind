import { describe, it, expect, afterEach } from "vitest";
import {
  resolveTicketValues,
  registerFallbackAssigneeResolver,
} from "./ticket-template.js";
import { AutomationError } from "../types.js";

// docs/specs/mandatory-ticket-fields.md R7 (owner decisions 2026-10-16).
const NOW = new Date("2030-01-01T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const db = {} as never;

const BASE = {
  template: undefined,
  ruleName: "Costing review",
  fieldsTitle: undefined,
  defaultTitle: "Costing review: Tender A",
  legacyAssignee: undefined,
  workflowId: "wf-1",
  now: NOW,
};

afterEach(() => registerFallbackAssigneeResolver(null));

describe("resolveTicketValues", () => {
  it("fills every gap with the defaults, including the fallback assignee", async () => {
    let askedFor: string | null = "";
    registerFallbackAssigneeResolver((_db, _tenant, workflowId) => {
      askedFor = workflowId;
      return Promise.resolve("owner-1");
    });

    expect(await resolveTicketValues(db, "t-1", BASE)).toEqual({
      title: "Costing review: Tender A",
      dueDate: new Date(NOW.getTime() + 3 * DAY).toISOString(),
      remark: "Created by automation: Costing review",
      severity: "medium",
      assignedTo: "owner-1",
    });
    expect(askedFor).toBe("wf-1");
  });

  it("uses the template's values where it sets them", async () => {
    expect(
      await resolveTicketValues(db, "t-1", {
        ...BASE,
        template: {
          title: "Price the roof",
          due_days: 7,
          remark: "From the tender",
          severity: "high",
          assignedTo: "analyst",
        },
      }),
    ).toEqual({
      title: "Price the roof",
      dueDate: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      remark: "From the tender",
      severity: "high",
      assignedTo: "analyst",
    });
  });

  it("keeps a title the rule's static fields already set, and an older single-assignee setting", async () => {
    const values = await resolveTicketValues(db, "t-1", {
      ...BASE,
      fieldsTitle: "Follow-up",
      legacyAssignee: "legacy-user",
    });
    expect(values.title).toBe("Follow-up");
    expect(values.assignedTo).toBe("legacy-user");
  });

  it("assigns a team instead of a person when the template names one", async () => {
    const values = await resolveTicketValues(db, "t-1", {
      ...BASE,
      template: { teamId: "team-1", assignedTo: "ignored" },
    });
    expect(values.teamId).toBe("team-1");
    expect(values).not.toHaveProperty("assignedTo");
  });

  it("refuses to create an unassigned ticket when nobody can be found", async () => {
    registerFallbackAssigneeResolver(() => Promise.resolve(null));
    await expect(resolveTicketValues(db, "t-1", BASE)).rejects.toMatchObject({
      code: "NO_ASSIGNEE",
    });
  });

  it("gives the failure a readable reason", async () => {
    registerFallbackAssigneeResolver(() => Promise.resolve(null));
    await expect(resolveTicketValues(db, "t-1", BASE)).rejects.toThrow(
      /set an assignee in the rule's template/,
    );
  });

  // Seed SQL bypasses the API's validation.
  it.each([-1, 1.5, Number.NaN])(
    "falls back to 3 days for an unusable due_days of %s",
    async (due_days) => {
      const values = await resolveTicketValues(db, "t-1", {
        ...BASE,
        template: { due_days, assignedTo: "u-1" },
      });
      expect(values.dueDate).toBe(
        new Date(NOW.getTime() + 3 * DAY).toISOString(),
      );
    },
  );

  it("also refuses when no resolver is registered", async () => {
    await expect(resolveTicketValues(db, "t-1", BASE)).rejects.toBeInstanceOf(
      AutomationError,
    );
  });
});
