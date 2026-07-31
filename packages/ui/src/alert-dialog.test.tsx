import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog.js";

afterEach(() => {
  cleanup();
});

describe("AlertDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <AlertDialog>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this record?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders an accessible alert dialog when open", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this record?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Delete this record?")).toBeDefined();
  });

  it("Cancel closes without invoking the destructive action", () => {
    const onAction = vi.fn();
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this record?</AlertDialogTitle>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onAction}>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("injects a singleton style tag in document.head when opened", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this record?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );

    const styleEl = document.getElementById("ow-alert-dialog-styles");
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain(".ow-alert-action:hover");
  });
});
