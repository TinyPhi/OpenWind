import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";
import React from "react";

const mockLogout = vi.fn().mockResolvedValue({ success: true });
vi.mock("../authProvider.js", () => ({
  authProvider: { logout: (...args: unknown[]) => mockLogout(...args) },
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

const { useIdleLogout } = await import("./use-idle-logout.js");

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

describe("useIdleLogout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLogout.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("logs out and navigates to /login after the timeout with no activity", async () => {
    renderHook(() => useIdleLogout(5000), { wrapper });

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockLogout).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/login");
  });

  it("resets the timer on activity, so no logout fires before a fresh timeout period elapses", async () => {
    renderHook(() => useIdleLogout(5000), { wrapper });

    await vi.advanceTimersByTimeAsync(4000);
    window.dispatchEvent(new Event("mousemove"));
    await vi.advanceTimersByTimeAsync(4000);

    // 8s elapsed since mount, but only 4s since the last reset — should not
    // have logged out yet.
    expect(mockLogout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockLogout).toHaveBeenCalled();
  });

  it("removes its activity listeners and clears the timer on unmount", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useIdleLogout(5000), { wrapper });

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));

    await vi.advanceTimersByTimeAsync(10000);
    expect(mockLogout).not.toHaveBeenCalled();

    removeSpy.mockRestore();
  });

  it("measures the idle window from the latest activity even when the throttle dropped that event", async () => {
    // timeout 5000 -> throttle window 1000ms
    renderHook(() => useIdleLogout(5000), { wrapper });

    await vi.advanceTimersByTimeAsync(1500);
    window.dispatchEvent(new Event("mousemove")); // accepted, timer -> t=6500
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new Event("mousemove")); // throttled (t=2000)

    await vi.advanceTimersByTimeAsync(4500); // t=6500: only 4500ms idle
    expect(mockLogout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500); // t=7000: 5000ms idle
    expect(mockLogout).toHaveBeenCalled();
  });

  it("registers activity listeners with passive flag", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { unmount } = renderHook(() => useIdleLogout(5000), { wrapper });

    expect(addSpy).toHaveBeenCalledWith("mousemove", expect.any(Function), {
      passive: true,
    });
    expect(addSpy).toHaveBeenCalledWith("scroll", expect.any(Function), {
      passive: true,
    });

    unmount();
    addSpy.mockRestore();
  });

  it("resets timeout if activity occurs during rescheduled remaining window", async () => {
    renderHook(() => useIdleLogout(5000), { wrapper });

    await vi.advanceTimersByTimeAsync(1500);
    window.dispatchEvent(new Event("mousemove")); // accepted, timer -> t=6500
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new Event("mousemove")); // throttled (t=2000)

    await vi.advanceTimersByTimeAsync(4500); // t=6500: timer fires, reschedules for remaining 500ms (t=7000)
    expect(mockLogout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200); // t=6700: user interacts during rescheduled window
    window.dispatchEvent(new Event("keydown")); // accepted -> new timer t=11700

    await vi.advanceTimersByTimeAsync(300); // t=7000: old rescheduled target passed, no logout
    expect(mockLogout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4699); // t=11699: 4999ms since t=6700
    expect(mockLogout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // t=11700: 5000ms idle
    expect(mockLogout).toHaveBeenCalled();
  });

  it("still navigates to /login when authProvider.logout rejects", async () => {
    mockLogout.mockRejectedValueOnce(new Error("Storage or network failure"));
    renderHook(() => useIdleLogout(5000), { wrapper });

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockLogout).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/login");
  });

  it("sustains active session under rapid high-frequency event bursts across multiple throttle windows", async () => {
    renderHook(() => useIdleLogout(5000), { wrapper });

    // User is active for 8 seconds, dispatching an event every 200ms
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(200);
      window.dispatchEvent(new Event("mousemove"));
    }

    // At t=8000, user stops. No logout yet despite 8 seconds total elapsed
    expect(mockLogout).not.toHaveBeenCalled();

    // 4000ms after last event (t=12000) -> still not logged out
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockLogout).not.toHaveBeenCalled();

    // 5000ms after last event (t=13000) -> logged out
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockLogout).toHaveBeenCalled();
  });
});

describe("useIdleLogout — config-driven via env (no explicit timeoutMs override)", () => {
  const originalEnabled = import.meta.env["VITE_IDLE_LOGOUT_ENABLED"];
  const originalMinutes = import.meta.env["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"];

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogout.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    import.meta.env["VITE_IDLE_LOGOUT_ENABLED"] = originalEnabled;
    import.meta.env["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"] = originalMinutes;
  });

  it("does not attach any listeners or timer when VITE_IDLE_LOGOUT_ENABLED=false", async () => {
    import.meta.env["VITE_IDLE_LOGOUT_ENABLED"] = "false";
    const addSpy = vi.spyOn(window, "addEventListener");

    renderHook(() => useIdleLogout(), { wrapper });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(mockLogout).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalledWith("mousemove", expect.any(Function));

    addSpy.mockRestore();
  });

  it("an explicit timeoutMs override does not re-enable the hook when VITE_IDLE_LOGOUT_ENABLED=false — the toggle is independent of the duration override", async () => {
    import.meta.env["VITE_IDLE_LOGOUT_ENABLED"] = "false";
    const addSpy = vi.spyOn(window, "addEventListener");

    renderHook(() => useIdleLogout(5000), { wrapper });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockLogout).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalledWith("mousemove", expect.any(Function));

    addSpy.mockRestore();
  });

  it("defaults to enabled with a 5-minute timeout when neither env var is set", async () => {
    import.meta.env["VITE_IDLE_LOGOUT_ENABLED"] = undefined;
    import.meta.env["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"] = undefined;

    renderHook(() => useIdleLogout(), { wrapper });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(mockLogout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockLogout).toHaveBeenCalled();
  });

  it("uses VITE_IDLE_LOGOUT_TIMEOUT_MINUTES to compute the timeout in ms", async () => {
    import.meta.env["VITE_IDLE_LOGOUT_ENABLED"] = undefined;
    import.meta.env["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"] = "10";

    renderHook(() => useIdleLogout(), { wrapper });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(mockLogout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockLogout).toHaveBeenCalled();
  });

  it("falls back to the 5-minute default for an invalid VITE_IDLE_LOGOUT_TIMEOUT_MINUTES value", async () => {
    import.meta.env["VITE_IDLE_LOGOUT_ENABLED"] = undefined;
    import.meta.env["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"] = "not-a-number";

    renderHook(() => useIdleLogout(), { wrapper });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockLogout).toHaveBeenCalled();
  });

  it("prefers window.__CONFIG__ over the Vite build-time env var (Docker runtime-config precedence, matches authProvider.ts)", async () => {
    import.meta.env["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"] = "5";
    (
      window as unknown as {
        __CONFIG__?: { IDLE_LOGOUT_TIMEOUT_MINUTES?: string };
      }
    ).__CONFIG__ = { IDLE_LOGOUT_TIMEOUT_MINUTES: "10" };

    renderHook(() => useIdleLogout(), { wrapper });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockLogout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockLogout).toHaveBeenCalled();

    delete (window as unknown as { __CONFIG__?: unknown }).__CONFIG__;
  });
});
