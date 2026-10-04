import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockFetchWithAuth = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("../../../lib/api.js", () => ({
  API_URL: "",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { StepActions } = await import("./step-actions.js");
const { EMPTY_WIZARD } = await import("./types.js");
import type {
  TransitionOption,
  TransitionsState,
} from "./transition-action.js";
import type { WizardData } from "./types.js";

afterEach(() => {
  cleanup();
  mockFetchWithAuth.mockReset();
});

const close: TransitionOption = {
  id: "t-close",
  fromState: "open",
  toState: "closed",
  label: "Close",
  allowedRoles: [],
  requiresComment: false,
};
const escalate: TransitionOption = {
  id: "t-escalate",
  fromState: "open",
  toState: "escalated",
  label: "Escalate",
  allowedRoles: ["admin"],
  requiresComment: false,
};
const reject: TransitionOption = {
  id: "t-reject",
  fromState: "open",
  toState: "rejected",
  label: null,
  allowedRoles: [],
  requiresComment: true,
};
const ready: TransitionsState = {
  status: "ready",
  transitions: [close, escalate, reject],
};

function withTransitionAction(config: Record<string, unknown>): WizardData {
  return {
    ...EMPTY_WIZARD,
    actions: [{ id: "a1", type: "transition", config }],
  };
}

describe("StepActions — transition action (#760)", () => {
  it("lists the workflow's transitions instead of asking for a typed name", () => {
    render(
      <StepActions
        data={withTransitionAction({})}
        onChange={vi.fn()}
        transitions={ready}
      />,
    );

    const select = screen.getByLabelText("Transition");
    expect(
      screen.getByRole("option", { name: "Close (open → closed)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "open → rejected" }),
    ).toBeTruthy();
    expect(select).toBeTruthy();
    expect(screen.queryByPlaceholderText("e.g. auto_approve")).toBeNull();
  });

  it("saves the picked transition's id", () => {
    const onChange = vi.fn();
    render(
      <StepActions
        data={withTransitionAction({})}
        onChange={onChange}
        transitions={ready}
      />,
    );

    fireEvent.change(screen.getByLabelText("Transition"), {
      target: { value: "t-close" },
    });

    expect(onChange).toHaveBeenCalledWith({
      actions: [
        { id: "a1", type: "transition", config: { transitionId: "t-close" } },
      ],
    });
  });

  it("preselects the stored transition when a saved rule is reopened", () => {
    render(
      <StepActions
        data={withTransitionAction({ transitionId: "t-close" })}
        onChange={vi.fn()}
        transitions={ready}
      />,
    );

    expect(
      (screen.getByLabelText("Transition") as HTMLSelectElement).value,
    ).toBe("t-close");
  });

  it("shows role-restricted transitions disabled, with the reason", () => {
    render(
      <StepActions
        data={withTransitionAction({})}
        onChange={vi.fn()}
        transitions={ready}
      />,
    );

    const option = screen.getByRole("option", {
      name: "Escalate (open → escalated) — Restricted to admin — automations can't run it",
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("asks for the comment a transition requires", () => {
    const onChange = vi.fn();
    render(
      <StepActions
        data={withTransitionAction({ transitionId: "t-reject" })}
        onChange={onChange}
        transitions={ready}
      />,
    );

    expect(screen.getByText("This transition needs a comment.")).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("Comment (required by this transition)"),
      { target: { value: "Out of policy" } },
    );
    expect(onChange).toHaveBeenCalledWith({
      actions: [
        {
          id: "a1",
          type: "transition",
          config: { transitionId: "t-reject", comment: "Out of policy" },
        },
      ],
    });
  });

  it("points to the Trigger step when the trigger pins no workflow or record type", () => {
    render(
      <StepActions
        data={withTransitionAction({})}
        onChange={vi.fn()}
        transitions={{ status: "no-workflow" }}
      />,
    );

    expect(
      screen.getByText(
        "Choose a workflow or record type on the Trigger step to pick a transition.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Transition")).toBeNull();
  });

  it("flags a stored transition that's no longer in the trigger's workflow", () => {
    render(
      <StepActions
        data={withTransitionAction({ transitionId: "t-gone" })}
        onChange={vi.fn()}
        transitions={ready}
      />,
    );

    expect(
      (screen.getByLabelText("Transition") as HTMLSelectElement).value,
    ).toBe("");
    expect(screen.getByText(/isn't in the trigger's workflow/)).toBeTruthy();
  });
});
