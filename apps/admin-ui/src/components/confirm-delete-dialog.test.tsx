import "../i18n.js";
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

  it("treats an omitted busy prop as not busy", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteDialog
        open
        message="Delete this?"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
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

  describe("typeToConfirm", () => {
    const renderTyped = (onConfirm = vi.fn()): ReturnType<typeof render> =>
      render(
        <ConfirmDeleteDialog
          open
          title="Erase this user?"
          message="This permanently erases Asha Rao."
          confirmLabel="Erase"
          typeToConfirm="Asha Rao"
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );

    it("keeps the confirm button disabled until the exact text is typed", () => {
      const onConfirm = vi.fn();
      renderTyped(onConfirm);
      const confirm = screen.getByRole("button", { name: "Erase" });
      const input = screen.getByLabelText("Type Asha Rao to confirm");
      expect(confirm.hasAttribute("disabled")).toBe(true);

      fireEvent.change(input, { target: { value: "Asha" } });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      fireEvent.change(input, { target: { value: "asha rao" } });
      expect(confirm.hasAttribute("disabled")).toBe(true);

      fireEvent.change(input, { target: { value: " Asha Rao " } });
      expect(confirm.hasAttribute("disabled")).toBe(false);
      fireEvent.click(confirm);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("starts empty again for a different person", () => {
      const { rerender } = renderTyped();
      fireEvent.change(screen.getByLabelText("Type Asha Rao to confirm"), {
        target: { value: "Asha Rao" },
      });
      rerender(
        <ConfirmDeleteDialog
          open
          message="This permanently erases Ravi Kumar."
          confirmLabel="Erase"
          typeToConfirm="Ravi Kumar"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const input = screen.getByLabelText(
        "Type Ravi Kumar to confirm",
      ) as HTMLInputElement;
      expect(input.value).toBe("");
      expect(
        screen.getByRole("button", { name: "Erase" }).hasAttribute("disabled"),
      ).toBe(true);
    });

    it("shows no text box for an ordinary delete", () => {
      render(
        <ConfirmDeleteDialog
          open
          message="Delete this?"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });
});
