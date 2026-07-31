import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./dialog.js";

afterEach(() => {
  cleanup();
});

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(
      <Dialog>
        <DialogContent>
          <DialogTitle>Edit Field</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders an accessible dialog when open", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Edit Field</DialogTitle>
          <DialogDescription>Change this field's settings.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Edit Field")).toBeDefined();
  });

  it("closes on Escape", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Edit Field</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a built-in close button that closes the dialog when clicked", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Edit Field</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toBeDefined();

    fireEvent.click(closeButton);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
