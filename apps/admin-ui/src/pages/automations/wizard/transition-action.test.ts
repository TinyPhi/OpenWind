import { describe, it, expect } from "vitest";
import {
  NO_WORKFLOW_MESSAGE,
  restrictionReason,
  transitionActionProblem,
  transitionOptionLabel,
  workflowSourceFor,
} from "./transition-action.js";
import type {
  TransitionOption,
  TransitionsState,
} from "./transition-action.js";

const open: TransitionOption = {
  id: "t-close",
  fromState: "open",
  toState: "closed",
  label: "Close",
  allowedRoles: [],
  requiresComment: false,
};
const restricted: TransitionOption = {
  ...open,
  id: "t-escalate",
  label: "Escalate",
  toState: "escalated",
  allowedRoles: ["admin", "agent"],
};
const needsComment: TransitionOption = {
  ...open,
  id: "t-reject",
  label: "Reject",
  toState: "rejected",
  requiresComment: true,
};
const ready: TransitionsState = {
  status: "ready",
  transitions: [open, restricted, needsComment],
};

describe("workflowSourceFor", () => {
  it("uses the trigger's workflow when one is chosen", () => {
    expect(workflowSourceFor({ workflowId: "wf-1" })).toEqual({
      workflowId: "wf-1",
    });
  });

  it("falls back to the record type, whose workflow is unique", () => {
    expect(workflowSourceFor({ entityTypeId: "et-1" })).toEqual({
      entityTypeId: "et-1",
    });
  });

  it("returns null when the trigger pins neither", () => {
    expect(workflowSourceFor({})).toBeNull();
    expect(workflowSourceFor({ workflowId: "", entityTypeId: "" })).toBeNull();
  });
});

describe("transitionOptionLabel", () => {
  it("shows the label with the state change", () => {
    expect(transitionOptionLabel(open)).toBe("Close (open → closed)");
  });

  it("shows only the state change for an unlabelled transition", () => {
    expect(transitionOptionLabel({ ...open, label: null })).toBe(
      "open → closed",
    );
  });
});

describe("restrictionReason", () => {
  it("explains why a role-restricted transition can't run from an automation", () => {
    expect(restrictionReason(restricted)).toBe(
      "Restricted to admin, agent — automations can't run it",
    );
  });

  it("is null for a transition open to everyone", () => {
    expect(restrictionReason(open)).toBeNull();
  });
});

describe("transitionActionProblem", () => {
  it("asks for a workflow or record type when the trigger pins neither", () => {
    expect(
      transitionActionProblem(
        { transitionId: "t-close" },
        {
          status: "no-workflow",
        },
      ),
    ).toBe(NO_WORKFLOW_MESSAGE);
  });

  it("blocks while transitions load or after they fail to load", () => {
    expect(transitionActionProblem({}, { status: "loading" })).not.toBeNull();
    expect(transitionActionProblem({}, { status: "error" })).not.toBeNull();
  });

  it("asks for a transition when none is chosen", () => {
    expect(transitionActionProblem({}, ready)).toBe("Choose a transition.");
  });

  it("flags a transition that isn't in the trigger's workflow", () => {
    expect(
      transitionActionProblem({ transitionId: "t-elsewhere" }, ready),
    ).toMatch(/isn't in the trigger's workflow/);
  });

  it("rejects a role-restricted transition", () => {
    expect(transitionActionProblem({ transitionId: "t-escalate" }, ready)).toBe(
      "Restricted to admin, agent — automations can't run it",
    );
  });

  it("requires a comment when the transition does", () => {
    expect(transitionActionProblem({ transitionId: "t-reject" }, ready)).toBe(
      "This transition needs a comment.",
    );
    expect(
      transitionActionProblem(
        { transitionId: "t-reject", comment: "  " },
        ready,
      ),
    ).toBe("This transition needs a comment.");
    expect(
      transitionActionProblem(
        { transitionId: "t-reject", comment: "Out of policy" },
        ready,
      ),
    ).toBeNull();
  });

  it("accepts a runnable transition of the trigger's workflow", () => {
    expect(
      transitionActionProblem({ transitionId: "t-close" }, ready),
    ).toBeNull();
  });
});
