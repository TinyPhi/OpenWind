import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const mockFetchWithAuth = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("../../../lib/api.js", () => ({
  API_URL: "",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { useTriggerTransitions } = await import("./use-trigger-transitions.js");
import type { TransitionOption } from "./transition-action.js";

afterEach(() => {
  cleanup();
  mockFetchWithAuth.mockReset();
});

const close: TransitionOption = {
  id: "t-close",
  fromState: "open",
  toState: "closed",
  label: "Close",
  allowedRoles: [],
  requiresComment: false,
};
const reject: TransitionOption = {
  id: "t-reject",
  fromState: "open",
  toState: "rejected",
  label: null,
  allowedRoles: [],
  requiresComment: true,
};

describe("useTriggerTransitions (#760)", () => {
  it("loads transitions of the trigger's workflow", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: { transitions: [close] } });

    const { result } = renderHook(() =>
      useTriggerTransitions({ workflowId: "wf-1" }, true),
    );

    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", transitions: [close] }),
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/workflows/wf-1");
  });

  it("finds the workflow of a record-type trigger, then loads its transitions", async () => {
    mockFetchWithAuth.mockImplementation((url) =>
      Promise.resolve(
        url.startsWith("/workflows?")
          ? { data: [{ id: "wf-7" }] }
          : { data: { transitions: [close] } },
      ),
    );

    const { result } = renderHook(() =>
      useTriggerTransitions({ entityTypeId: "et-1" }, true),
    );

    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", transitions: [close] }),
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/workflows?entityTypeId=et-1",
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/workflows/wf-7");
  });

  it("reports no workflow, without fetching, when the trigger pins neither", () => {
    const { result } = renderHook(() => useTriggerTransitions({}, true));

    expect(result.current).toEqual({ status: "no-workflow" });
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("doesn't fetch while the rule has no transition action", () => {
    renderHook(() => useTriggerTransitions({ workflowId: "wf-1" }, false));

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("never returns the previous workflow's transitions after the trigger's workflow changes", async () => {
    let resolveSecond: (v: unknown) => void = () => undefined;
    mockFetchWithAuth
      .mockResolvedValueOnce({ data: { transitions: [close] } })
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveSecond = r;
        }),
      );

    const { result, rerender } = renderHook(
      ({ wf }: { wf: string }) =>
        useTriggerTransitions({ workflowId: wf }, true),
      { initialProps: { wf: "wf-1" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ wf: "wf-2" });
    expect(result.current).toEqual({ status: "loading" });

    resolveSecond({ data: { transitions: [reject] } });
    await waitFor(() =>
      expect(result.current).toEqual({
        status: "ready",
        transitions: [reject],
      }),
    );
  });

  it("reports an error when the workflow can't be loaded", async () => {
    mockFetchWithAuth.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() =>
      useTriggerTransitions({ workflowId: "wf-1" }, true),
    );

    await waitFor(() => expect(result.current).toEqual({ status: "error" }));
  });
});
