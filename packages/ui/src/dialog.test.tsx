import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DIALOG_CONTENT_RESET,
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

  it("places the built-in close button before children in DOM order for accessible tab navigation", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Edit Field</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    const closeButton = screen.getByRole("button", { name: "Close" });
    const title = screen.getByText("Edit Field");

    expect(dialog.firstElementChild).toBe(closeButton);
    expect(
      closeButton.compareDocumentPosition(title) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("omits the built-in close button when showCloseButton is false", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Edit Field</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("DIALOG_CONTENT_RESET lets a caller's own CSS win over DialogContent's defaults", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent className="modal" style={DIALOG_CONTENT_RESET}>
          <DialogTitle>Edit Field</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.style.background).toBe("");
    expect(dialog.style.padding).toBe("0px");
  });
});
