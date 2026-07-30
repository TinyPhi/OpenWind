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
});
