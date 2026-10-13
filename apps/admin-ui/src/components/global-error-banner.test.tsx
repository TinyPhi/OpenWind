import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import "../i18n.js";

// session-expiry.ts imports userManager; the notice path under test never calls it.
vi.mock("../authProvider.js", () => ({ userManager: {} }));

const NOTICE_KEY = "ow:auth-notice";

let networkListeners: Set<() => void>;
let networkSnapshot: { kind: string };

vi.mock("../lib/network-status.js", () => ({
  subscribe: (listener: () => void) => {
    networkListeners.add(listener);
    return () => networkListeners.delete(listener);
  },
  getSnapshot: () => networkSnapshot,
}));

const { GlobalErrorBanner } = await import("./global-error-banner.js");

function setNetworkState(kind: string): void {
  networkSnapshot = { kind };
  act(() => {
    for (const l of networkListeners) l();
  });
}

function dispatchApiError(type: "server", message: string): void {
  window.dispatchEvent(
    new CustomEvent("api:error", { detail: { type, message } }),
  );
}

describe("GlobalErrorBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    networkListeners = new Set();
    networkSnapshot = { kind: "online" };
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing when there are no errors and the network is online", () => {
    const { container } = render(<GlobalErrorBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the offline banner, persistent, when network status is offline", () => {
    render(<GlobalErrorBanner />);
    act(() => setNetworkState("offline"));

    expect(screen.getByText("You're offline")).toBeDefined();
  });

  it("shows the Reconnecting banner when network status is reconnecting", () => {
    render(<GlobalErrorBanner />);
    act(() => setNetworkState("reconnecting"));

    expect(screen.getByText("Reconnecting…")).toBeDefined();
  });

  it("shows Back online transiently when network status is recovered", () => {
    render(<GlobalErrorBanner />);
    act(() => setNetworkState("recovered"));

    expect(screen.getByText("Back online")).toBeDefined();
  });

  it("has role=status and aria-live=polite on the banner container", () => {
    render(<GlobalErrorBanner />);
    act(() => setNetworkState("offline"));

    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("marks banner icons aria-hidden so they aren't announced twice", () => {
    render(<GlobalErrorBanner />);
    act(() => {
      dispatchApiError("server", "Something broke");
    });

    const icon = document.querySelector(".geb-icon");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the session-expired notice on the page load after a forced logout", () => {
    window.sessionStorage.setItem(NOTICE_KEY, "session_expired");
    render(<GlobalErrorBanner />);

    expect(
      screen.getByText("Your session has expired. Please sign in again."),
    ).toBeDefined();
    expect(screen.queryByText("Log in again")).toBeNull();
  });

  it("shows the session-expired notice only once", () => {
    window.sessionStorage.setItem(NOTICE_KEY, "session_expired");
    render(<GlobalErrorBanner />);
    cleanup();
    render(<GlobalErrorBanner />);

    expect(
      screen.queryByText("Your session has expired. Please sign in again."),
    ).toBeNull();
  });

  it("keeps the session-expired notice until dismissed (no 6s auto-dismiss)", () => {
    window.sessionStorage.setItem(NOTICE_KEY, "session_expired");
    render(<GlobalErrorBanner />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const message = "Your session has expired. Please sign in again.";
    expect(screen.getByText(message)).toBeDefined();

    act(() => {
      screen.getByText("Dismiss").click();
    });
    expect(screen.queryByText(message)).toBeNull();
  });

  it("auto-dismisses a server error banner after 6s", () => {
    render(<GlobalErrorBanner />);
    act(() => {
      dispatchApiError("server", "Something broke");
    });
    expect(screen.getByText("Something broke")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.queryByText("Something broke")).toBeNull();
  });

  it("shows both a network banner and the session-expired notice together", () => {
    window.sessionStorage.setItem(NOTICE_KEY, "session_expired");
    render(<GlobalErrorBanner />);
    act(() => {
      setNetworkState("reconnecting");
    });

    expect(screen.getByText("Reconnecting…")).toBeDefined();
    expect(
      screen.getByText("Your session has expired. Please sign in again."),
    ).toBeDefined();
  });
});
