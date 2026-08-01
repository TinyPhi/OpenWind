import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import {
  GlobalAlertDialog,
  showAlert,
  showConfirm,
} from "./global-alert-dialog.js";

afterEach(() => {
  cleanup();
});

describe("GlobalAlertDialog", () => {
  it("renders nothing until showAlert/showConfirm is called", () => {
    render(<GlobalAlertDialog />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("showAlert renders a single-button dialog with the message", () => {
    render(<GlobalAlertDialog />);
    act(() => {
      showAlert("Something went wrong", "Error");
    });

    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.queryByText("Cancel")).toBeNull();
    expect(screen.getByText("OK")).toBeDefined();
  });

  it("showAlert's dialog dismisses on OK", () => {
    render(<GlobalAlertDialog />);
    act(() => {
      showAlert("Heads up");
    });
    fireEvent.click(screen.getByText("OK"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("showConfirm resolves true when Confirm is clicked", async () => {
    render(<GlobalAlertDialog />);
    let pending!: Promise<boolean>;
    act(() => {
      pending = showConfirm("Delete this?", "Delete record");
    });

    expect(screen.getByText("Delete record")).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await expect(pending).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("showConfirm resolves false when Cancel is clicked", async () => {
    render(<GlobalAlertDialog />);
    let pending!: Promise<boolean>;
    act(() => {
      pending = showConfirm("Delete this?", "Delete record");
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await expect(pending).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("queues a second request while the first is open", () => {
    render(<GlobalAlertDialog />);
    act(() => {
      showAlert("First message");
      showAlert("Second message");
    });

    expect(screen.getByText("First message")).toBeDefined();
    expect(screen.queryByText("Second message")).toBeNull();

    fireEvent.click(screen.getByText("OK"));
    expect(screen.getByText("Second message")).toBeDefined();
  });
});
