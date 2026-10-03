import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RouteErrorBoundary } from "./route-error-boundary.js";

interface CrashingChildProps {
  shouldThrow: boolean;
}

function CrashingChild({
  shouldThrow,
}: CrashingChildProps): React.ReactElement {
  if (shouldThrow) {
    throw new Error(
      "Failed to fetch dynamically imported module: /assets/records-chunk-xyz.js",
    );
  }
  return <div>Safe child content</div>;
}

describe("RouteErrorBoundary", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders children normally when no error occurs", () => {
    render(
      <RouteErrorBoundary resetKey="/dashboard">
        <div>Safe child content</div>
      </RouteErrorBoundary>,
    );

    expect(screen.getByText("Safe child content")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("catches render/lazy-chunk errors and renders the user-facing alert fallback", () => {
    render(
      <RouteErrorBoundary resetKey="/failing-chunk">
        <CrashingChild shouldThrow={true} />
      </RouteErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(
      screen.getByText(
        "This page failed to load. It may have been updated — reload to get the latest version.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
  });

  it("triggers window.location.reload when the user clicks the Reload button", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    });

    render(
      <RouteErrorBoundary resetKey="/failing-chunk">
        <CrashingChild shouldThrow={true} />
      </RouteErrorBoundary>,
    );

    const reloadButton = screen.getByRole("button", { name: "Reload" });
    fireEvent.click(reloadButton);

    expect(reloadMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("resets error state when resetKey changes upon navigating to another route", () => {
    function TestNavigationHarness(): React.ReactElement {
      const [path, setPath] = useState("/failing-route");
      return (
        <div>
          <button type="button" onClick={(): void => setPath("/safe-route")}>
            Navigate to Safe Route
          </button>
          <RouteErrorBoundary resetKey={path}>
            <CrashingChild shouldThrow={path === "/failing-route"} />
          </RouteErrorBoundary>
        </div>
      );
    }

    render(<TestNavigationHarness />);

    // Initially in error state
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.queryByText("Safe child content")).toBeNull();

    // User clicks navigation to safe route
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to Safe Route" }),
    );

    // Error state is reset, safe child content renders cleanly
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Safe child content")).toBeDefined();
  });

  it("retains the error fallback when rerendered with an identical resetKey", () => {
    const { rerender } = render(
      <RouteErrorBoundary resetKey="/failing-route">
        <CrashingChild shouldThrow={true} />
      </RouteErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeDefined();

    rerender(
      <RouteErrorBoundary resetKey="/failing-route">
        <div>Other content</div>
      </RouteErrorBoundary>,
    );

    // Error boundary must not reset if the route pathname has not changed
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.queryByText("Other content")).toBeNull();
  });
});
