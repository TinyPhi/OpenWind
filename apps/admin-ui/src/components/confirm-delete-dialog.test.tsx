import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog.js";

afterEach(() => {
  cleanup();
});

describe("ConfirmDeleteDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <ConfirmDeleteDialog
        open={false}
        message="Delete this?"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders the default title, message, and generic warning when open", () => {
    render(
      <ConfirmDeleteDialog
        open
        message="Delete this attachment?"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByText("Delete this item?")).toBeDefined();
    expect(screen.getByText("Delete this attachment?")).toBeDefined();
    expect(screen.getByText("This action cannot be undone.")).toBeDefined();
  });

  it("supports a custom title, confirm label, and error message", () => {
    render(
      <ConfirmDeleteDialog
        open
        title="Delete workflow?"
        message="This removes all its steps."
        confirmLabel="Delete Workflow"
        errorMessage="Something went wrong"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete workflow?")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Delete Workflow" }),
    ).toBeDefined();
    expect(screen.getByText("⚠ Something went wrong")).toBeDefined();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteDialog
        open
        message="Delete this?"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteDialog
        open
        message="Delete this?"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables both buttons and shows the busy label while busy", () => {
    render(
      <ConfirmDeleteDialog
        open
        message="Delete this?"
        busy
        busyLabel="Removing…"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Removing…" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
