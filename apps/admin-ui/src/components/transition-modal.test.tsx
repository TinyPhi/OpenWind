import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TransitionModal } from "./transition-modal.js";

afterEach(() => {
  cleanup();
});

const BASE_RECORD = { fields: {} };

describe("TransitionModal", () => {
  it("renders nothing when closed", () => {
    render(
      <TransitionModal
        open={false}
        record={BASE_RECORD}
        transition={{ requiresComment: false, requiresFields: [] }}
        toStateLabel="Resolved"
        allFields={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the target state and an accessible dialog when open", () => {
    render(
      <TransitionModal
        open
        record={BASE_RECORD}
        transition={{ requiresComment: false, requiresFields: [] }}
        toStateLabel="Resolved"
        allFields={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Move to Resolved")).toBeDefined();
  });

  it("Confirm is disabled until a required comment is entered", () => {
    render(
      <TransitionModal
        open
        record={BASE_RECORD}
        transition={{ requiresComment: true, requiresFields: [] }}
        toStateLabel="Resolved"
        allFields={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    expect(confirmButton).toHaveProperty("disabled", true);

    fireEvent.change(
      screen.getByPlaceholderText("Add a comment for this transition…"),
      { target: { value: "Looks good" } },
    );
    expect(confirmButton).toHaveProperty("disabled", false);
  });

  it("calls onConfirm with the comment and field updates", () => {
    const onConfirm = vi.fn();
    render(
      <TransitionModal
        open
        record={BASE_RECORD}
        transition={{ requiresComment: true, requiresFields: ["priority"] }}
        toStateLabel="Resolved"
        allFields={[
          {
            id: "f1",
            name: "priority",
            label: "Priority",
            fieldType: "text",
            config: {},
          },
        ]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText("Add a comment for this transition…"),
      { target: { value: "Done" } },
    );
    fireEvent.change(screen.getByPlaceholderText("Enter priority…"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledWith("Done", { priority: "high" });
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <TransitionModal
        open
        record={BASE_RECORD}
        transition={{ requiresComment: false, requiresFields: [] }}
        toStateLabel="Resolved"
        allFields={[]}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
