import "../i18n.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { ToastHost, showToast, TOAST_DURATION_MS } from "./toast.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastHost", () => {
  it("keeps an empty live region mounted before any toast, so the first one is announced", () => {
    render(<ToastHost />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("shows the title, message and tone of each toast in a live region", () => {
    render(<ToastHost />);
    act(() => {
      showToast({ title: "Saved.", message: "All good.", tone: "success" });
      showToast({ title: "Careful.", tone: "warning" });
    });
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    const toasts = screen.getAllByTestId("toast");
    expect(toasts.map((t) => t.getAttribute("data-tone"))).toEqual([
      "success",
      "warning",
    ]);
    expect(screen.getByText("Saved.")).toBeDefined();
    expect(screen.getByText("All good.")).toBeDefined();
    expect(screen.getByText("Careful.")).toBeDefined();
  });

  it("can be dismissed", () => {
    render(<ToastHost />);
    act(() => showToast({ title: "Saved." }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("goes away on its own after a while", () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => showToast({ title: "Saved." }));
    expect(screen.getByText("Saved.")).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS + 1);
    });
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});
