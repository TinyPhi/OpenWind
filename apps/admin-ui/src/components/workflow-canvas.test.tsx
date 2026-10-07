import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransitionPanel } from "./workflow-canvas.js";

describe("TransitionPanel accessibility", () => {
  afterEach(cleanup);

  it("exposes the slide-in editor as a labelled region with labelled fields", () => {
    render(
      <TransitionPanel
        data={{
          mode: "new",
          fromState: "open",
          toState: "closed",
          label: "",
          allowedRoles: "",
          requiresComment: false,
        }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "New Transition" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Label" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", {
        name: "Allowed roles (comma-separated)",
      }),
    ).toBeTruthy();
  });
});
